"""Motor de deteccion para la aplicacion (copia de prueba, identica a la del proyecto)."""
import math
import os

import cv2
import numpy as np

import deteccion_camiones as dc
from eventos import DetectorEventos
import georreferencia


TIPOS_ZONA = ("acumulativa", "dinamica")
BRILLO_MINIMO_VISTA = 25
UMBRAL_ENTRADA_ZONA = 0.90
UMBRAL_SALIDA_ZONA = 0.10
SEGUNDOS_ESTADO_INICIAL = 1.0
COLORES_ZONA = {"acumulativa": (0, 128, 255), "dinamica": (255, 0, 255)}   # BGR
VELOCIDADES = {"Precision": 1, "Equilibrado": 1.5, "Rapido": 2}
SEGUNDOS_SIN_VELOCIDAD = 1.0
SALTO_MAXIMO_LARGOS_S = 2.0
MARGEN_BORDE_PX = 3
LARGO_MINIMO_REL = 0.80
LARGO_MAXIMO_REL = 1.25


def clasificar_camiones(camiones):
    for c in camiones:
        c["usado"], c["motivo"] = True, ""
        if c.get("borde"):
            c["usado"], c["motivo"] = False, "cortado por el borde"
    completos = [c["largo"] for c in camiones if c["usado"]]
    if completos:
        ref = float(np.percentile(completos, 70))
        for c in camiones:
            if not c["usado"]:
                continue
            if c["largo"] < ref * LARGO_MINIMO_REL:
                c["usado"], c["motivo"] = False, "incompleto (más corto que el resto)"
            elif c["largo"] > ref * LARGO_MAXIMO_REL:
                c["usado"], c["motivo"] = False, "más grande que el resto"
    return camiones


def resumen_camiones(largos, anchos):
    if not largos:
        return None
    largos, anchos = np.asarray(largos, float), np.asarray(anchos, float)
    largo = float(np.median(largos))
    q1, q3 = np.percentile(largos, [25, 75])
    return {"n": int(len(largos)), "largo_px": largo, "ancho_px": float(np.median(anchos)),
            "variacion": float((q3 - q1) / largo) if largo else 0.0}


class Motor:
    def __init__(self, modelo_path=dc.MODEL_PATH):
        self.modelo_path = modelo_path
        self.dispositivo = dc.elegir_dispositivo()
        self.model = None
        self.es_obb = False
        self.cap = None
        self.video_path = None
        self.fps = 30.0
        self.total_frames = 0
        self.resolucion_original = (dc.ANCHO_VISUAL, dc.ALTO_VISUAL)
        self.primer_frame = None
        self.skip_frames = 1.5
        self.zonas = []
        self.tipos = []
        self.nombres = []
        self.limites = []
        self.limite_general = None
        self.mascaras = []
        self.georef = None
        self.medidas_camion = []
        self._modelo_medida = None
        self.ultimo_limpio = None
        self._reiniciar_estado()

    # ---------- carga ----------
    def cargar_modelo(self):
        from ultralytics import YOLO
        if not os.path.exists(self.modelo_path):
            raise FileNotFoundError(f"No se encontro el modelo '{self.modelo_path}'.")
        dc.configurar_bytetrack()
        self.model = YOLO(self.modelo_path)
        self.es_obb = getattr(self.model, "task", "") == "obb"

    def abrir_video(self, ruta):
        cap = cv2.VideoCapture(ruta)
        if not cap.isOpened():
            raise ValueError("No se pudo abrir el video.")
        ok, frame = cap.read()
        if not ok or frame is None:
            cap.release()
            raise ValueError("El video no tiene cuadros legibles.")
        if self.cap is not None:
            self.cap.release()
        self.cap = cap
        self.video_path = ruta
        fps = cap.get(cv2.CAP_PROP_FPS)
        self.fps = fps if fps and fps > 0 else 30.0
        self.total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
        alto, ancho = frame.shape[:2]
        self.resolucion_original = (ancho, alto)
        vista = frame
        limite = int(self.fps * 10)
        n = 0
        while vista is not None and float(vista.mean()) < BRILLO_MINIMO_VISTA and n < limite:
            ok, siguiente = cap.read()
            if not ok:
                break
            vista, n = siguiente, n + 1
        if vista is None or float(vista.mean()) < BRILLO_MINIMO_VISTA:
            vista = frame
        else:
            for _ in range(int(self.fps * 2)):
                ok, siguiente = cap.read()
                if not ok or float(siguiente.mean()) <= float(vista.mean()) * 1.01:
                    break
                vista = siguiente
        self.primer_frame = cv2.resize(vista, (dc.ANCHO_VISUAL, dc.ALTO_VISUAL))
        self.medidas_camion = []
        self.georef = None
        self.cargar_calibracion()
        self.reiniciar()

    # ---------- estado ----------
    def _reiniciar_estado(self):
        self.ultimo_limpio = None
        self.contador_frames = 0
        self.iniciado = False
        self.terminado = False
        self.totales = {}
        self.ocupacion = {}
        self.estado_zona = {}
        self.base_dinamica = set()
        self.consecutivos = {}
        self.cajas_visuales = {}
        self.poligonos = {}
        self.gestor = None
        self.registro = None
        self.ultimo_frame = None
        self.alertas = []
        self.velocidades = {}
        self._t_inicio = {}
        self.muestras_vel = []
        self.pos_velocidad = {}
        self.camiones_visibles = []
        self.limite_actual = {}
        self.exceso_desde = {}
        self.exceso_avisado = set()
        self._t_vel = {}
        self.estadisticas_vel = {}
        self.detector_eventos = None

    def reiniciar(self):
        if self.cap is not None:
            self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        self._reiniciar_estado()
        if self.model is not None:
            self.cargar_modelo()

    def preparar(self):
        self.totales = {i: 0 for i in range(len(self.zonas))}
        self.ocupacion = {i: 0 for i, t in enumerate(self.tipos) if t == "dinamica"}
        self.frames_filtro = max(1, int(round(self.fps * dc.FILTRO_SEGUNDOS / max(1, self.skip_frames))))
        self.frames_iniciales = 0
        self.gestor = dc.FleetIdentityManager(
            max_camiones=dc.MAX_CAMIONES,
            margen_perturbacion=dc.MARGEN_PERTURBACION_PX,
            frames_post_perturbacion=max(1, int(round(self.fps * dc.SEGUNDOS_POST_PERTURBACION))),
            iou_min_protegido=dc.IOU_MIN_PROTEGIDO,
            frames_confirmar_fuera=max(1, int(round(self.fps * dc.SEGUNDOS_CONFIRMAR_SALIDA))),
            frames_olvidar=max(1, int(round(self.fps * dc.SEGUNDOS_OLVIDAR_PERDIDO))),
            frames_confirmar_entrada=max(1, int(round(self.fps * dc.SEGUNDOS_CONFIRMAR_ENTRADA))),
        )
        ancho, alto = self.resolucion_original
        self.registro = dc.RegistroDatos(
            self.video_path, self.fps, math.ceil(max(1, self.skip_frames)),
            [self.rect_envolvente(z) for z in self.zonas],
            list(self.tipos), escala_x=ancho / dc.ANCHO_VISUAL, escala_y=alto / dc.ALTO_VISUAL,
            resolucion_original=self.resolucion_original)
        self.registro.nombres_zonas = self.nombres
        self.registro.georef = self.georef
        self.registro.estadisticas_vel = self.estadisticas_vel
        self.registro.limites_velocidad = self._texto_limites
        self.alertas = []
        self.registro.alertas = self.alertas
        self.detector_eventos = DetectorEventos(ancho / dc.ANCHO_VISUAL, alto / dc.ALTO_VISUAL,
                                                dc.ANCHO_VISUAL, dc.ALTO_VISUAL)
        self.iniciado = True

    # ---------- georreferencia ----------
    def a_pixel_original(self, x, y):
        ancho, alto = self.resolucion_original
        return x * ancho / dc.ANCHO_VISUAL, y * alto / dc.ALTO_VISUAL

    def definir_georef(self, puntos, info=None):
        self.georef = georreferencia.Georreferencia(puntos, info)
        if self.registro is not None:
            self.registro.georef = self.georef
        return self.georef

    def _medir_poligono(self, poli):
        ancho, alto = self.resolucion_original
        p = np.asarray(poli, dtype=float).reshape(-1, 2) * [ancho / dc.ANCHO_VISUAL, alto / dc.ALTO_VISUAL]
        if len(p) != 4:
            return
        lados = sorted([math.hypot(*(p[1] - p[0])), math.hypot(*(p[2] - p[1]))])
        if lados[0] < 2:
            return
        self.medidas_camion.append((lados[1], lados[0]))
        if len(self.medidas_camion) > 4000:
            del self.medidas_camion[:1000]

    def cuadro_limpio(self):
        return self.ultimo_limpio if self.ultimo_limpio is not None else self.primer_frame

    def camiones_en_cuadro(self, frame):
        if frame is None or not os.path.exists(self.modelo_path):
            return []
        try:
            if self._modelo_medida is None:
                from ultralytics import YOLO
                self._modelo_medida = YOLO(self.modelo_path)
            res = self._modelo_medida.predict(frame, conf=dc.CONF_DETECCION, imgsz=dc.IMGSZ_DETECCION,
                                              device=self.dispositivo, verbose=False)
            det = res[0].obb if res and getattr(res[0], "obb", None) is not None else None
            if det is None or not hasattr(det, "xyxyxyxy"):
                return []
            polis = det.xyxyxyxy.cpu().numpy()
        except Exception as error:
            print(f"Aviso: no se pudo medir los camiones: {error}")
            return []
        ancho, alto = self.resolucion_original
        fx, fy = ancho / dc.ANCHO_VISUAL, alto / dc.ALTO_VISUAL
        m = MARGEN_BORDE_PX
        camiones = []
        for poli in polis:
            p = np.asarray(poli, dtype=float).reshape(-1, 2)
            if len(p) != 4:
                continue
            borde = bool((p[:, 0] <= m).any() or (p[:, 1] <= m).any() or
                         (p[:, 0] >= dc.ANCHO_VISUAL - 1 - m).any() or (p[:, 1] >= dc.ALTO_VISUAL - 1 - m).any())
            p = p * [fx, fy]
            lados = sorted([math.hypot(*(p[1] - p[0])), math.hypot(*(p[2] - p[1]))])
            if lados[0] < 2:
                continue
            camiones.append({"poli": p.tolist(), "largo": lados[1], "ancho": lados[0], "borde": borde})
        return clasificar_camiones(camiones)

    def medicion_cuadro(self, frame):
        camiones = self.camiones_en_cuadro(frame)
        usados = [c for c in camiones if c["usado"]]
        if usados:
            r = resumen_camiones([c["largo"] for c in usados], [c["ancho"] for c in usados])
        else:
            r = self.medir_camiones(usar_cuadro=False) or {}
        r["camiones"] = camiones
        return r if (r.get("n") or camiones) else None

    def medir_camiones(self, usar_cuadro=True):
        medidas = [{"largo": l, "ancho": a} for l, a in self.medidas_camion]
        if len(medidas) < 15 and usar_cuadro:
            medidas += [c for c in self.camiones_en_cuadro(self.primer_frame) if not c["borde"]]
        if not medidas:
            return None
        usados = [c for c in clasificar_camiones(medidas) if c["usado"]]
        return resumen_camiones([c["largo"] for c in usados], [c["ancho"] for c in usados])

    # ---------- calibracion guardada junto al video ----------
    def ruta_calibracion(self):
        return (self.video_path + ".calibracion.json") if self.video_path else None

    def guardar_calibracion(self):
        ruta = self.ruta_calibracion()
        if not ruta:
            return
        try:
            if self.georef is None:
                if os.path.exists(ruta):
                    os.remove(ruta)
                return
            import json
            with open(ruta, "w", encoding="utf-8") as f:
                json.dump({"resolucion": list(self.resolucion_original), **self.georef.a_dict()},
                          f, indent=2, ensure_ascii=False)
        except OSError as error:
            print(f"Aviso: no se pudo guardar la calibracion: {error}")

    def cargar_calibracion(self):
        ruta = self.ruta_calibracion()
        if not ruta or not os.path.exists(ruta):
            return False
        try:
            import json
            with open(ruta, encoding="utf-8") as f:
                datos = json.load(f)
            if tuple(datos.get("resolucion", ())) != tuple(self.resolucion_original):
                return False
            self.georef = georreferencia.Georreferencia.desde_dict(datos)
            return True
        except (OSError, ValueError, KeyError, TypeError):
            return False

    def georef_ejemplo(self):
        ancho, alto = self.resolucion_original
        return self.definir_georef(georreferencia.ejemplo(ancho, alto).puntos)

    def quitar_georef(self):
        self.georef = None
        if self.registro is not None:
            self.registro.georef = None

    def coordenadas(self, x, y):
        if self.georef is None:
            return None
        return self.georef.a_coordenadas(*self.a_pixel_original(x, y))

    def metros_por_pixel(self):
        if self.georef is None:
            return None
        ancho, alto = self.resolucion_original
        return self.georef.escala_m_px * math.sqrt(ancho / dc.ANCHO_VISUAL * alto / dc.ALTO_VISUAL)

    def _actualizar_velocidades(self, tracks):
        if self.georef is None:
            self.velocidades = {}
            return
        from collections import deque
        t = self.tiempo_actual()
        estados = self.gestor.estados
        for pid, (x, y, w, h) in tracks:
            estado = estados.get(pid)
            if estado == "PROTEGIDO":
                self.velocidades[pid] = 0.0
                continue
            if estado != "DETECTADO":
                continue
            e, n = self.coordenadas(x + w / 2, y + h / 2)
            inicio = self._t_inicio.setdefault(pid, t)
            d = self.pos_velocidad.setdefault(pid, deque())
            if d:
                t0, e0, n0 = d[-1]
                px_s = math.hypot(e - e0, n - n0) / self.georef.escala_m_px / max(t - t0, 0.1)
                if px_s > SALTO_MAXIMO_LARGOS_S * self._largo_tipico_px():
                    d.clear()
            d.append((t, e, n))
            while d and t - d[0][0] > 3.0:
                d.popleft()
            antes = next((m for m in d if t - m[0] <= 1.2), None)
            if antes is None or t - antes[0] < 0.6 or t - inicio < SEGUNDOS_SIN_VELOCIDAD:
                continue
            kmh = math.hypot(e - antes[1], n - antes[2]) / (t - antes[0]) * 3.6
            previa = self.velocidades.get(pid)
            kmh = kmh if previa is None else 0.6 * previa + 0.4 * kmh
            kmh = 0.0 if kmh < 1.5 else kmh
            dt = t - self._t_vel.get(pid, t)
            self._t_vel[pid] = t
            self.velocidades[pid] = kmh
            if kmh >= 1.5:
                self.muestras_vel.append(kmh / self.georef.escala_m_px)
                if len(self.muestras_vel) > 2000:
                    del self.muestras_vel[:500]
            self._revisar_limite(pid, x + w / 2, y + h / 2, kmh, t, dt)

    def _largo_tipico_px(self):
        if len(self.medidas_camion) >= 5:
            return float(np.median([m[0] for m in self.medidas_camion[-200:]]))
        largo = self.georef.info.get("largo_px") if self.georef is not None else None
        return float(largo) if largo else 0.03 * self.resolucion_original[0]

    def velocidad_tipica_factor(self):
        if len(self.muestras_vel) < 10:
            return None
        return float(np.median(self.muestras_vel[-600:]))

    # ---------- limite de velocidad ----------
    def definir_limite_zona(self, z, kmh):
        if 0 <= z < len(self.limites):
            self.limites[z] = kmh if kmh and kmh > 0 else None

    def limite_en(self, x, y):
        xi, yi = int(min(max(x, 0), dc.ANCHO_VISUAL - 1)), int(min(max(y, 0), dc.ALTO_VISUAL - 1))
        mejor = None
        for z, lim in enumerate(self.limites):
            if lim and z < len(self.mascaras) and self.mascaras[z][yi, xi]:
                if mejor is None or lim < mejor[0]:
                    mejor = (lim, self.nombre_zona(z))
        if mejor is not None:
            return mejor
        return (self.limite_general, None) if self.limite_general else (None, None)

    def _revisar_limite(self, pid, cx, cy, kmh, t, dt):
        est = self.estadisticas_vel.setdefault(pid, {"vel_max": 0.0, "t_exceso": 0.0, "excesos": 0})
        est["vel_max"] = max(est["vel_max"], kmh)
        limite, zona = self.limite_en(cx, cy)
        self.limite_actual[pid] = (limite, zona)
        if not limite or kmh <= limite + 1.0:
            self.exceso_desde.pop(pid, None)
            if not limite or kmh < limite - 2.0:
                self.exceso_avisado.discard(pid)
            return
        est["t_exceso"] += max(0.0, dt)
        inicio = self.exceso_desde.setdefault(pid, t)
        if t - inicio >= 1.0 and pid not in self.exceso_avisado and self.detector_eventos is not None:
            self.exceso_avisado.add(pid)
            est["excesos"] += 1
            donde = f" en {zona}" if zona else ""
            e = self.detector_eventos.aviso_exceso(inicio, pid, kmh, limite, donde)
            if e:
                self.alertas.append(e)

    def _texto_limites(self):
        filas = [("Limite de velocidad general (km/h)", self.limite_general or "sin limite")]
        for z, lim in enumerate(self.limites):
            if lim:
                filas.append((f"Limite de velocidad en {self.nombre_zona(z)} (km/h)", lim))
        return filas

    def estado_camiones(self):
        return [(pid, caja, self.velocidades.get(pid)) for pid, caja in list(self.camiones_visibles)]

    def recorrido_m(self, pid):
        if self.georef is None or self.registro is None or pid not in self.registro.camiones:
            return None
        return self.registro._distancia_metros(self.registro.camiones[pid]).get("distancia_m")

    def usar_georef(self, georef):
        self.georef = georef
        if self.registro is not None:
            self.registro.georef = georef
        self.pos_velocidad = {}
        self.velocidades = {}

    # ---------- zonas ----------
    @staticmethod
    def rect_envolvente(puntos):
        x, y, w, h = cv2.boundingRect(np.array(puntos, np.int32))
        return (x, y, w, h)

    def nombre_zona(self, z):
        nombre = self.nombres[z].strip() if z < len(self.nombres) else ""
        return nombre or f"Zona {z + 1}"

    def renombrar_zona(self, z, nombre):
        if 0 <= z < len(self.nombres):
            self.nombres[z] = (nombre or "").strip()[:40]

    def agregar_zona(self, puntos, tipo, nombre=""):
        puntos = [(int(round(x)), int(round(y))) for x, y in puntos]
        mascara = np.zeros((dc.ALTO_VISUAL, dc.ANCHO_VISUAL), np.uint8)
        cv2.fillPoly(mascara, [np.array(puntos, np.int32)], 1)
        self.zonas.append(puntos)
        self.tipos.append(tipo)
        self.nombres.append((nombre or "").strip()[:40])
        self.limites.append(None)
        self.mascaras.append(mascara)

    def deshacer_zona(self):
        if self.zonas:
            self.zonas.pop()
            self.tipos.pop()
            self.nombres.pop()
            self.limites.pop()
            self.mascaras.pop()

    def borrar_zonas(self):
        self.zonas.clear()
        self.tipos.clear()
        self.nombres.clear()
        self.limites.clear()
        self.mascaras.clear()

    def fraccion_dentro(self, caja, z, poligono=None):
        if poligono is not None:
            pts = np.round(np.asarray(poligono, np.float32)).astype(np.int32)
            area = max(1.0, cv2.contourArea(pts.astype(np.float32)))
            x, y, w, h = cv2.boundingRect(pts)
        else:
            x, y, w, h = (int(v) for v in caja)
            area = max(1, w * h)
        x1, y1 = max(0, x), max(0, y)
        x2, y2 = min(dc.ANCHO_VISUAL, x + w), min(dc.ALTO_VISUAL, y + h)
        if x2 <= x1 or y2 <= y1:
            return 0.0
        zona = self.mascaras[z][y1:y2, x1:x2]
        if poligono is None:
            return float(np.count_nonzero(zona)) / area
        local = np.zeros_like(zona)
        cv2.fillPoly(local, [pts - [x1, y1]], 1)
        dentro = np.count_nonzero(local & zona)
        return min(1.0, dentro / area)

    def clasificar(self, caja, z, poligono=None):
        fraccion = self.fraccion_dentro(caja, z, poligono)
        if fraccion >= UMBRAL_ENTRADA_ZONA:
            return "dentro"
        if fraccion <= UMBRAL_SALIDA_ZONA:
            return "fuera"
        return None

    @staticmethod
    def _poligono_punteado(frame, puntos, color, grosor=2, largo=10, espacio=6):
        n = len(puntos)
        for i in range(n):
            (xa, ya), (xb, yb) = puntos[i], puntos[(i + 1) % n]
            dist = math.hypot(xb - xa, yb - ya)
            if dist < 1:
                continue
            paso = largo + espacio
            t = 0.0
            while t < dist:
                f0, f1 = t / dist, min(t + largo, dist) / dist
                p0 = (int(xa + (xb - xa) * f0), int(ya + (yb - ya) * f0))
                p1 = (int(xa + (xb - xa) * f1), int(ya + (yb - ya) * f1))
                cv2.line(frame, p0, p1, color, grosor, cv2.LINE_AA)
                t += paso

    def dibujar_zonas(self, frame):
        for i, puntos in enumerate(self.zonas):
            self._poligono_punteado(frame, puntos, COLORES_ZONA[self.tipos[i]])
        return frame

    def vista_previa(self):
        if self.primer_frame is None:
            return None
        return self.dibujar_zonas(self.primer_frame.copy())

    # ---------- procesamiento ----------
    def _debe_inferir(self):
        n, s = self.contador_frames, self.skip_frames
        return s <= 1 or n == 1 or int(n / s) != int((n - 1) / s)

    def siguiente(self):
        if self.cap is None or self.model is None:
            return None
        if not self.iniciado:
            self.preparar()
        ok, original = self.cap.read()
        if not ok:
            self.terminado = True
            return None
        self.contador_frames += 1
        frame = cv2.resize(original, (dc.ANCHO_VISUAL, dc.ALTO_VISUAL))
        tracks = []

        if self._debe_inferir():
            res = self.model.track(source=frame, conf=dc.CONF_DETECCION, imgsz=dc.IMGSZ_DETECCION,
                                   iou=dc.IOU_NMS, tracker=dc.TRACKER_CONFIG, persist=True,
                                   device=self.dispositivo, verbose=False)
            res = res[0] if res else None
            det = None
            if res is not None:
                det = res.obb if getattr(res, "obb", None) is not None else res.boxes
            observaciones, poligonos_int = [], {}
            if det is not None and det.id is not None:
                ids = det.id.int().cpu().tolist()
                cajas = det.xyxy.cpu().tolist()
                polis = det.xyxyxyxy.cpu().numpy() if hasattr(det, "xyxyxyxy") else [None] * len(ids)
                for tid, (x1, y1, x2, y2), poli in zip(ids, cajas, polis):
                    caja = (int(x1), int(y1), max(1, int(x2 - x1)), max(1, int(y2 - y1)))
                    observaciones.append((tid, caja))
                    if poli is not None:
                        cx, cy = dc.centro_caja(caja)
                        poligonos_int[tid] = poli.astype("float32") - [cx, cy]
            for pid, caja, interno in self.gestor.actualizar(observaciones, self.contador_frames):
                tracks.append((pid, caja))
                if interno in poligonos_int and self.gestor.estados.get(pid) == "DETECTADO":
                    self.poligonos[pid] = poligonos_int[interno]
                    self._medir_poligono(poligonos_int[interno])
                anterior = self.cajas_visuales.get(pid)
                if anterior is not None and dc.iou_cajas(anterior, caja) > 0.3:
                    s = dc.SUAVIZADO_VISUAL
                    self.cajas_visuales[pid] = tuple(int(round(s * a + (1 - s) * b))
                                                     for a, b in zip(anterior, caja))
                else:
                    self.cajas_visuales[pid] = caja
            self._contar(tracks)
            try:
                self.detector_eventos.m_por_px = self.metros_por_pixel()
                self.alertas.extend(self.detector_eventos.actualizar(
                    self.tiempo_actual(), tracks, self.gestor.estados, self.poligonos,
                    self.zonas, self.nombre_zona,
                    lambda z: bool(z < len(self.nombres) and self.nombres[z].strip())))
            except Exception as error:
                print(f"Aviso: error al revisar eventos: {error}")
            self.registro.registrar(self.contador_frames, tracks, self.gestor.estados,
                                    self.gestor.records, self.estado_zona)
            self._actualizar_velocidades(tracks)
        else:
            for pid, r in self.gestor.records.items():
                if r["state"] == "ACTIVE" and r["bbox"] is not None:
                    dt = self.contador_frames - r["last_frame"]
                    self.cajas_visuales[pid] = tuple(max(1, int(v + vel * dt))
                                                     for v, vel in zip(r["bbox"], r["velocity"]))

        self.ultimo_limpio = frame.copy()
        visibles = [(pid, c) for pid, c in self.cajas_visuales.items()
                    if self.gestor.records.get(pid, {}).get("state") == "ACTIVE"]
        self.camiones_visibles = visibles
        self.dibujar_zonas(frame)
        dc.dibujar_camiones(frame, visibles, [], self.poligonos)
        self.ultimo_frame = frame
        return frame

    def _contar(self, tracks):
        for pid, caja in tracks:
            poligono = None
            if pid in self.poligonos:
                cx, cy = dc.centro_caja(caja)
                poligono = self.poligonos[pid] + [cx, cy]
            for z in range(len(self.zonas)):
                observado = self.clasificar(caja, z, poligono)
                k = (pid, z)
                confirmado = self.estado_zona.get(k, "fuera")
                if observado == "dentro" and confirmado == "fuera":
                    self.consecutivos[k] = self.consecutivos.get(k, 0) + 1
                    if self.consecutivos[k] >= self.frames_filtro:
                        contado = self.contador_frames > self.frames_iniciales
                        if contado:
                            self.totales[z] += 1
                        if self.tipos[z] == "dinamica":
                            if self.tiempo_actual() <= SEGUNDOS_ESTADO_INICIAL:
                                self.base_dinamica.add(k)
                            else:
                                self.ocupacion[z] = self.ocupacion.get(z, 0) + 1
                        self.estado_zona[k] = "dentro"
                        self.consecutivos[k] = 0
                        self.registro.evento(self.contador_frames, pid, z, "ENTRADA", contado=contado)
                        if self.detector_eventos is not None and self.tiempo_actual() > 1.0:
                            e = self.detector_eventos.aviso_entrada_zona(
                                self.tiempo_actual(), pid, self.nombre_zona(z))
                            if e:
                                self.alertas.append(e)
                elif observado == "fuera" and confirmado == "dentro":
                    self.consecutivos[k] = self.consecutivos.get(k, 0) + 1
                    if self.consecutivos[k] >= self.frames_filtro:
                        self.estado_zona[k] = "fuera"
                        self.consecutivos[k] = 0
                        if self.tipos[z] == "dinamica":
                            if k in self.base_dinamica:
                                self.base_dinamica.discard(k)
                            else:
                                self.ocupacion[z] = max(0, self.ocupacion.get(z, 0) - 1)
                        self.registro.evento(self.contador_frames, pid, z, "SALIDA")
                else:
                    self.consecutivos[k] = 0

    # ---------- informacion para la interfaz ----------
    def conteos(self):
        filas = []
        for z, tipo in enumerate(self.tipos):
            if tipo == "dinamica":
                filas.append((self.nombre_zona(z), tipo, self.ocupacion.get(z, 0)))
            else:
                filas.append((self.nombre_zona(z), tipo, self.totales.get(z, 0)))
        return filas

    def camiones_activos(self):
        if self.gestor is None:
            return 0
        return sum(1 for r in self.gestor.records.values() if r["state"] == "ACTIVE")

    def tiempo_actual(self):
        return self.contador_frames / self.fps

    def duracion(self):
        return self.total_frames / self.fps if self.total_frames else 0.0

    def progreso(self):
        return min(1.0, self.contador_frames / self.total_frames) if self.total_frames else 0.0

    def exportar(self, carpeta):
        if self.registro is None:
            return None
        return self.registro.exportar(carpeta)

    def cerrar(self):
        if self.cap is not None:
            self.cap.release()
            self.cap = None
