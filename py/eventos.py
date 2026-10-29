"""Deteccion de eventos para las notificaciones de la app.

Trabaja solo con las posiciones de los camiones que entrega el motor, asi que sirve igual
para la app de escritorio y para la futura version web.
"""
import math
from collections import deque

import cv2
import numpy as np

# Las distancias se miden en "largos de camion" (L): asi funciona igual en cualquier video.
LARGO_POR_DEFECTO = 30.0          # px (cuadro de 800x600) si aun no hay camiones medidos
VEL_MOVIMIENTO = 0.6              # L/s: por encima, el camion esta en movimiento
VEL_DETENIDO = 0.15               # L/s: por debajo, el camion esta detenido
VENTANA_VELOCIDAD = 0.6           # s usados para medir la velocidad (menos = avisos mas rapidos)
VENTANA_QUIETO = 0.8              # s: si en este tiempo casi no se movio, esta detenido
TOL_QUIETO = 0.15                 # L: cuanto puede "temblar" la caja estando detenido
RECORRIDO_MINIMO = 0.6            # L: cuanto debio avanzar antes de detenerse para avisarlo
DESPLAZAMIENTO_ARRANQUE = 0.3     # L: cuanto debe alejarse de donde estaba para "en marcha"
QUIETO_PREVIO = 1.0               # s que debio estar quieto antes de avisar "en marcha"
DIST_CERCANO = 0.5                # L: separacion maxima entre cajas para "paso muy cercano"
DIST_SEPARADOS = 1.0              # L: deben alejarse esto para volver a avisar la misma pareja
MARGEN_BORDE = 1.5                # L: cercania al borde para "salio/ingresa a la pantalla"
SEGUNDOS_SIN_VER = 0.8            # sin detectarse este tiempo cerca del borde = salio
DIST_ACERCAMIENTO = 2.5           # L: distancia a la zona para avisar que se acerca
ACERCAMIENTO_MIN = 0.4            # L: cuanto debe haberse acercado en el ultimo segundo
DIST_RUTA = 1.2                   # L: cercania a un punto ya recorrido para "regresa"
DIST_RUTA_TRAS_GIRO = 3.0         # L: idem, si acaba de dar la vuelta (el carril de regreso esta al lado)
GIRO_CURVA = 40                   # grados de cambio de rumbo en ~2 s para "curva"
GIRO_VUELTA = 150                 # grados acumulados en <= 8 s para "dio la vuelta"
GIRO_RETROCESO = 140              # grados entre el sentido de antes y el de ahora
EJE_QUIETO = 25                   # grados: el camion no giro su carroceria (retroceso)
EJE_GIRADO = 60                   # grados: la carroceria si giro (vuelta en U)

ESPERA = {                        # segundos antes de repetir el mismo aviso para el mismo camion
    "ACERCAMIENTO": 25.0, "PASO_CERCANO": 3.0, "DETENIDO": 2.0, "ARRANQUE": 2.0, "CURVA": 8.0,
    "REGRESO": 40.0, "RETROCESO": 15.0, "GIRO_180": 20.0, "ENTRADA_ZONA": 3.0,
    "SALIDA_PANTALLA": 5.0, "ENTRADA_PANTALLA": 5.0, "EXCESO_VELOCIDAD": 8.0,
}
NIVEL = {"ACERCAMIENTO": "info", "PASO_CERCANO": "aviso", "DETENIDO": "aviso", "ARRANQUE": "info",
         "CURVA": "info", "REGRESO": "aviso", "RETROCESO": "alerta", "GIRO_180": "alerta",
         "ENTRADA_ZONA": "info", "SALIDA_PANTALLA": "info", "ENTRADA_PANTALLA": "info",
         "EXCESO_VELOCIDAD": "alerta"}
INTERVALO_REVISION = 0.2          # s entre revisiones (ahorra calculo)
HISTORIA_S = 10.0                 # historia corta (velocidad y giros)
RUTA_S = 90.0                     # historia larga (para reconocer el camino ya recorrido)


def _dif_angulo(a, b):
    """Diferencia a-b en grados, entre -180 y 180."""
    return (a - b + 180.0) % 360.0 - 180.0


def _dif_eje(a, b):
    """Diferencia entre dos ejes (sin sentido), entre 0 y 90 grados."""
    d = abs(a - b) % 180.0
    return min(d, 180.0 - d)


class DetectorEventos:
    def __init__(self, escala_x=1.0, escala_y=1.0, ancho=800, alto=600):
        self.sx, self.sy = escala_x, escala_y
        self.ancho, self.alto = ancho, alto
        self.m_por_px = None
        self.parejas_cerca = set()
        self.quieto_previo = {}
        self.marcha = {}
        self.salidos = set()
        self.vistos = set()
        self.t_inicio = None
        self.historia = {}
        self.rumbos = {}
        self.ruta = {}
        self.detenido_desde = {}
        self.marcha_desde = {}
        self.marcha_previa = {}
        self.dentro_hasta = {}
        self.ultimo_aviso = {}
        self.ultima_revision = -1.0
        self.largo = LARGO_POR_DEFECTO
        self.pendientes = []

    # ---------- datos ----------
    def _cerca_del_borde(self, x, y, w, h):
        m = MARGEN_BORDE * max(self.largo, 5.0)
        return x < m or y < m or x + w > self.ancho - m or y + h > self.alto - m

    def _registrar(self, t, tracks, estados, poligonos):
        largos = []
        vivos = set()
        if self.t_inicio is None:
            self.t_inicio = t
        for pid, (x, y, w, h) in tracks:
            vivos.add(pid)
            if pid not in self.vistos or pid in self.salidos:
                if t - self.t_inicio > 1.5 and estados.get(pid) != "PREDICHO" \
                        and self._cerca_del_borde(x, y, w, h):
                    e = self._avisar(t, "ENTRADA_PANTALLA", pid, "Ingresa a la pantalla",
                                     f"El camión {pid} aparece en la imagen.")
                    if e:
                        self.pendientes.append(e)
                self.vistos.add(pid)
                self.salidos.discard(pid)
            largos.append(max(w, h))
            if estados.get(pid) == "PREDICHO":
                continue
            eje = None
            poli = poligonos.get(pid)
            if poli is not None and len(poli) == 4:
                p = np.asarray(poli, dtype=float) * [self.sx, self.sy]
                lados = [p[(i + 1) % 4] - p[i] for i in range(2)]
                largo = max(lados, key=lambda v: v[0] ** 2 + v[1] ** 2)
                eje = math.degrees(math.atan2(largo[1], largo[0])) % 180.0
            d = self.historia.setdefault(pid, deque())
            d.append((t, x + w / 2.0, y + h / 2.0, eje))
            while d and t - d[0][0] > HISTORIA_S:
                d.popleft()
        if largos:
            medido = float(np.median(largos))
            self.largo = 0.8 * self.largo + 0.2 * medido if self.largo else medido
        for pid, d in self.historia.items():
            if pid in self.salidos or not d or t - d[-1][0] < SEGUNDOS_SIN_VER:
                continue
            _, cx, cy, _ = d[-1]
            L = max(self.largo, 5.0)
            if self._cerca_del_borde(cx - L / 2, cy - L / 2, L, L):
                self.salidos.add(pid)
                e = self._avisar(t, "SALIDA_PANTALLA", pid, "Salió de la pantalla",
                                 f"El camión {pid} sale de la imagen y sigue su recorrido.", tiempo=d[-1][0])
                if e:
                    self.pendientes.append(e)
        for pid in list(self.historia):
            if pid not in vivos and t - self.historia[pid][-1][0] > 3.0:
                for dic in (self.historia, self.rumbos, self.ruta, self.detenido_desde,
                            self.marcha_desde, self.marcha_previa, self.quieto_previo, self.marcha):
                    dic.pop(pid, None)

    def _muestra(self, pid, hace):
        d = self.historia.get(pid)
        if not d:
            return None
        objetivo = d[-1][0] - hace
        return min(d, key=lambda m: abs(m[0] - objetivo))

    def _velocidad(self, pid, ventana=VENTANA_VELOCIDAD):
        d = self.historia.get(pid)
        if not d or len(d) < 3:
            return None
        ahora = d[-1]
        antes = self._muestra(pid, ventana)
        dt = ahora[0] - antes[0]
        if dt < ventana * 0.6:
            return None
        vx = (ahora[1] - antes[1]) * self.sx / dt
        vy = (ahora[2] - antes[2]) * self.sy / dt
        return vx, vy

    def aviso_entrada_zona(self, t, pid, nombre):
        return self._avisar(t, "ENTRADA_ZONA", pid, f"Entrada a {nombre}",
                            f"El camión {pid} entró a {nombre}.", extra=nombre, zona=nombre)

    def aviso_exceso(self, t, pid, kmh, limite, donde=""):
        return self._avisar(t, "EXCESO_VELOCIDAD", pid, "Exceso de velocidad",
                            f"El camión {pid} va a {kmh:.0f} km/h; el límite{donde} es {limite:g} km/h.",
                            tiempo=t, corto=f"Camión {pid} a {kmh:.0f} km/h (máx. {limite:g}{donde})")

    def _avisar(self, t, tipo, pid, titulo, detalle, extra=None, zona=None, tiempo=None, corto=None):
        clave = (tipo, pid, extra)
        if t - self.ultimo_aviso.get(clave, -1e9) < ESPERA[tipo]:
            return None
        self.ultimo_aviso[clave] = t
        return {"tiempo_s": round(t if tiempo is None else tiempo, 2), "tipo": tipo,
                "nivel": NIVEL[tipo], "id_camion": pid, "zona": zona,
                "titulo": titulo, "detalle": detalle, "mensaje": f"{titulo}: {detalle}",
                "corto": corto or f"Camión {pid}"}

    # ---------- revision ----------
    def actualizar(self, t, tracks, estados, poligonos, zonas, nombre_zona, zona_con_nombre=None):
        self._registrar(t, tracks, estados, poligonos)
        if t - self.ultima_revision < INTERVALO_REVISION:
            return []
        self.ultima_revision = t
        L = max(self.largo, 5.0)
        L_real = L * math.sqrt(self.sx * self.sy)
        cajas = dict(tracks)
        contornos = [np.array(z, np.float32).reshape(-1, 1, 2) for z in zonas]
        nuevos = []

        def zona_de(cx, cy):
            for z, c in enumerate(contornos):
                if len(c) >= 3 and cv2.pointPolygonTest(c, (float(cx), float(cy)), False) >= 0:
                    return z
            return None

        nuevos.extend(self.pendientes)
        self.pendientes = []
        velocidades = {}
        for pid in cajas:
            v = self._velocidad(pid)
            if v is None:
                continue
            rapidez = math.hypot(*v) / L_real
            velocidades[pid] = (v, rapidez)
            x, y, w, h = cajas[pid]
            cx, cy = x + w / 2.0, y + h / 2.0
            if rapidez > VEL_MOVIMIENTO:
                rumbo = math.degrees(math.atan2(v[1], v[0]))
                self.rumbos.setdefault(pid, deque()).append((t, rumbo))
                ruta = self.ruta.setdefault(pid, deque())
                if not ruta or t - ruta[-1][0] >= 0.5:
                    ruta.append((t, cx, cy, rumbo))
            for dic, limite in ((self.rumbos, HISTORIA_S), (self.ruta, RUTA_S)):
                r = dic.get(pid)
                while r and t - r[0][0] > limite:
                    r.popleft()

        for pid in cajas:
            e = self._revisar_marcha(t, pid, L, zona_de, nombre_zona)
            if e:
                nuevos.append(e)

        ids = sorted(cajas)
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                ax, ay, aw, ah = cajas[a]
                bx, by, bw, bh = cajas[b]
                gx = max(0.0, max(bx - (ax + aw), ax - (bx + bw)))
                gy = max(0.0, max(by - (ay + ah), ay - (by + bh)))
                separacion = math.hypot(gx, gy)
                pareja = (a, b)
                if separacion > DIST_SEPARADOS * L:
                    self.parejas_cerca.discard(pareja)
                    continue
                if separacion > DIST_CERCANO * L or pareja in self.parejas_cerca:
                    continue
                va = velocidades.get(a, (None, 0.0))[1]
                vb = velocidades.get(b, (None, 0.0))[1]
                qa = self.marcha.get(a, {}).get("estado") != "MOV"
                qb = self.marcha.get(b, {}).get("estado") != "MOV"
                if qa and qb and max(va, vb) <= VEL_MOVIMIENTO:
                    continue
                self.parejas_cerca.add(pareja)
                movil, otro = (a, b) if (qb and not qa) or (qa == qb and va >= vb) else (b, a)
                quieto = qa or qb
                if self.m_por_px:
                    metros = separacion * self.m_por_px
                    a_dist = "a menos de 1 m" if metros < 1 else f"a {metros:.0f} m"
                else:
                    a_dist = "muy cerca"
                detalle = (f"El camión {movil} pasa {a_dist} del camión {otro}, que está detenido."
                           if quieto else f"Los camiones {movil} y {otro} pasan {a_dist} uno del otro.")
                corto = (f"Camión {movil} {a_dist} del {otro} (detenido)" if quieto
                         else f"Camiones {movil} y {otro}, {a_dist}")
                e = self._avisar(t, "PASO_CERCANO", movil, "Paso muy cercano", detalle, extra=otro,
                                 corto=corto)
                if e:
                    nuevos.append(e)

        for pid, (v, rapidez) in velocidades.items():
            x, y, w, h = cajas[pid]
            cx, cy = x + w / 2.0, y + h / 2.0
            if rapidez <= VEL_MOVIMIENTO:
                continue
            antes = self._muestra(pid, 1.0)
            for z, contorno in enumerate(contornos):
                if len(contorno) < 3 or (zona_con_nombre is not None and not zona_con_nombre(z)):
                    continue
                dist = -cv2.pointPolygonTest(contorno, (float(cx), float(cy)), True)
                if dist <= 0:
                    self.dentro_hasta[(pid, z)] = t
                    continue
                if t - self.dentro_hasta.get((pid, z), -1e9) < 5.0 or dist > DIST_ACERCAMIENTO * L:
                    continue
                dist_antes = -cv2.pointPolygonTest(contorno, (float(antes[1]), float(antes[2])), True)
                if dist_antes - dist >= ACERCAMIENTO_MIN * L:
                    e = self._avisar(t, "ACERCAMIENTO", pid, f"Acercándose a {nombre_zona(z)}",
                                     f"El camión {pid} se dirige a {nombre_zona(z)}.",
                                     extra=z, zona=nombre_zona(z))
                    if e:
                        nuevos.append(e)

            nuevos.extend(self._revisar_giros(t, pid))
            nuevos.extend(self._revisar_regreso(t, pid, cx, cy, L))
        return nuevos

    def _quieto(self, pid, L):
        d = self.historia.get(pid)
        if not d:
            return None
        t = d[-1][0]
        muestras = [(tt, x, y) for tt, x, y, _ in d if t - tt <= VENTANA_QUIETO]
        if len(muestras) < 3 or muestras[-1][0] - muestras[0][0] < VENTANA_QUIETO * 0.7:
            return None
        mx = sum(m[1] for m in muestras) / len(muestras)
        my = sum(m[2] for m in muestras) / len(muestras)
        tercio = max(1, len(muestras) // 3)
        x0 = sum(m[1] for m in muestras[:tercio]) / tercio
        y0 = sum(m[2] for m in muestras[:tercio]) / tercio
        x1 = sum(m[1] for m in muestras[-tercio:]) / tercio
        y1 = sum(m[2] for m in muestras[-tercio:]) / tercio
        quieto = (max(math.hypot(m[1] - mx, m[2] - my) for m in muestras) <= TOL_QUIETO * L
                  and math.hypot(x1 - x0, y1 - y0) <= 0.10 * L)
        return quieto, (mx, my), muestras[0][0]

    def _revisar_marcha(self, t, pid, L, zona_de, nombre_zona):
        d = self.historia.get(pid)
        q = self._quieto(pid, L)
        if not d or q is None:
            return None
        quieto, centro, desde = q
        _, cx, cy, _ = d[-1]
        estado = self.marcha.get(pid)
        if estado is None:
            if quieto:
                self.marcha[pid] = {"estado": "QUIETO", "ancla": centro, "desde": desde}
            else:
                self.marcha[pid] = {"estado": "MOV", "origen": (d[0][1], d[0][2]), "max": 0.0}
            return None
        if estado["estado"] == "QUIETO":
            ax, ay = estado["ancla"]
            if math.hypot(cx - ax, cy - ay) < DESPLAZAMIENTO_ARRANQUE * L:
                return None
            inicio = next((tt for tt, x, y, _ in d if tt >= estado["desde"]
                           and math.hypot(x - ax, y - ay) > 0.12 * L), t)
            estuvo_quieto = inicio - estado["desde"]
            self.marcha[pid] = {"estado": "MOV", "origen": (ax, ay), "max": 0.0}
            if estuvo_quieto >= QUIETO_PREVIO:
                return self._avisar(t, "ARRANQUE", pid, "Camión en marcha",
                                    f"El camión {pid} empezó a moverse.", tiempo=inicio)
            return None
        ox, oy = estado["origen"]
        estado["max"] = max(estado["max"], math.hypot(cx - ox, cy - oy))
        if not quieto:
            return None
        recorrido = estado["max"]
        self.marcha[pid] = {"estado": "QUIETO", "ancla": centro, "desde": desde}
        if recorrido < RECORRIDO_MINIMO * L:
            return None
        z = zona_de(*centro)
        lugar = f" en {nombre_zona(z)}" if z is not None else ""
        return self._avisar(t, "DETENIDO", pid, "Camión detenido",
                            f"El camión {pid} se detuvo{lugar}.", tiempo=desde, corto=f"Camión {pid}{lugar}")

    def _revisar_regreso(self, t, pid, cx, cy, L):
        ruta = self.ruta.get(pid)
        r = self.rumbos.get(pid)
        if not ruta or not r:
            return []
        rumbo = r[-1][1]
        ultimo_giro = max(self.ultimo_aviso.get(("GIRO_180", pid, None), -1e9),
                          self.ultimo_aviso.get(("RETROCESO", pid, None), -1e9))
        if t - ultimo_giro < 2.5:
            return []
        limite = (DIST_RUTA_TRAS_GIRO if t - ultimo_giro < 20.0 else DIST_RUTA) * L
        for ts, x, y, rs in ruta:
            if t - ts < 8.0:
                break
            if math.hypot(x - cx, y - cy) <= limite and abs(_dif_angulo(rumbo, rs)) >= 135:
                e = self._avisar(t, "REGRESO", pid, "Regresa por la misma ruta",
                                 f"El camión {pid} vuelve por el camino que ya recorrió.")
                return [e] if e else []
        return []

    def _revisar_giros(self, t, pid):
        nuevos = []
        r = self.rumbos.get(pid)
        if not r or len(r) < 3:
            return nuevos
        rumbo_ahora = r[-1][1]

        def giro_desde(segundos):
            total, previo, inicio = 0.0, None, None
            for tt, rr in r:
                if t - tt > segundos:
                    continue
                if previo is not None:
                    paso = _dif_angulo(rr, previo)
                    if abs(paso) <= 100:
                        total += paso
                else:
                    inicio = tt
                previo = rr
            return total, (t - inicio) if inicio is not None else 0.0

        ejes = [(tt, e) for tt, _, _, e in self.historia.get(pid, ()) if e is not None]

        def giro_eje(desde):
            seleccion = [e for tt, e in ejes if t - tt <= desde]
            if len(seleccion) < 2:
                return None
            return max(_dif_eje(e, seleccion[0]) for e in seleccion)

        giro8, dur8 = giro_desde(8.0)
        eje8 = giro_eje(8.0)
        if abs(giro8) >= GIRO_VUELTA and dur8 >= 1.0 and (eje8 is None or eje8 >= EJE_GIRADO):
            e = self._avisar(t, "GIRO_180", pid, "Cambio de sentido",
                             f"El camión {pid} dio la vuelta y ahora va en sentido contrario.")
            if e:
                nuevos.append(e)
                self.ultimo_aviso[("CURVA", pid, None)] = t
                return nuevos

        anteriores = [rr for tt, rr in r if 2.0 <= t - tt <= 6.0]
        if anteriores:
            opuesto = max(abs(_dif_angulo(rumbo_ahora, rr)) for rr in anteriores)
            eje6 = giro_eje(6.0)
            if opuesto >= GIRO_RETROCESO and eje6 is not None and eje6 <= EJE_QUIETO:
                e = self._avisar(t, "RETROCESO", pid, "Marcha atrás",
                                 f"El camión {pid} está retrocediendo.")
                if e:
                    nuevos.append(e)
                    return nuevos

        giro2, dur2 = giro_desde(2.0)
        if GIRO_CURVA <= abs(giro2) < GIRO_RETROCESO and dur2 >= 1.0:
            e = self._avisar(t, "CURVA", pid, "Camión en curva", f"El camión {pid} está tomando una curva.")
            if e:
                nuevos.append(e)
        return nuevos
