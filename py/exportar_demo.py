"""Exporta un video ya analizado para la pagina web (modo demostracion).

Usa motor.py TAL CUAL (el mismo motor de la app de escritorio): abre el video, corre YOLO
y el seguimiento cuadro por cuadro, y guarda todo lo que la web necesita para reproducir
el video con las cajas, los numeros, las velocidades, los avisos y los conteos
sincronizados. No modifica ningun archivo del proyecto.

Uso (en la carpeta del proyecto, D:\\PROYECTO_MINAS):
    python exportar_demo.py
    python exportar_demo.py --video "ORIGINAL .mp4" --zonas zonas.json --modo Equilibrado

Al terminar crea la carpeta  web\\datos\\<nombre>\\  con:
    demo.json        -> cajas, IDs, velocidades, conteos y avisos de cada cuadro
    resultados.json  -> datos del reporte (para el dashboard)
    reporte.xlsx     -> el mismo Excel que exporta la app
    video.mp4        -> copia del video para la web
y actualiza web\\datos\\catalogo.json (lista de videos de demostracion) y copia
reporte_excel.py a web\\py\\ (la web lo usa para armar el Excel con las zonas del visitante).
"""
import argparse
import json
import math
import os
import shutil
import sys
import tempfile
import time
import unicodedata

CARPETA = os.path.dirname(os.path.abspath(__file__))
# Mismos valores que el boton "Velocidad de analisis" de la app (cada cuantos cuadros corre YOLO).
MODOS = {"precision": ("Precisión", 1), "equilibrado": ("Equilibrado", 1.25), "rapido": ("Rápido", 1.5)}
SEGUNDOS_ENTRE_MEDIDAS = 20.0      # cada cuanto se miden los camiones para la calibracion en la web
LIMITE_ARCHIVO_MB = 25             # Cloudflare Pages no acepta archivos mas grandes
# Archivos de Python que la pagina usa dentro del navegador (se copian a web\py)
ARCHIVOS_WEB = ("reporte_excel.py", "motor.py", "deteccion_camiones.py", "eventos.py", "georreferencia.py",
                "exportar_demo.py")


def _sin_tildes(texto):
    texto = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode()
    limpio = "".join(c.lower() if c.isalnum() else "-" for c in texto)
    while "--" in limpio:
        limpio = limpio.replace("--", "-")
    return limpio.strip("-") or "video"


def _hms(segundos):
    s = int(max(0, segundos))
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def _r1(v):
    return round(float(v), 1)


def _json_seguro(valor):
    """Convierte tuplas, numeros de numpy y objetos raros a algo que JSON entienda."""
    if isinstance(valor, dict):
        return {str(k): _json_seguro(v) for k, v in valor.items()}
    if isinstance(valor, (list, tuple, set)):
        return [_json_seguro(v) for v in valor]
    if isinstance(valor, float):
        return None if (math.isnan(valor) or math.isinf(valor)) else valor
    if isinstance(valor, (int, str, bool)) or valor is None:
        return valor
    if hasattr(valor, "item"):            # numpy
        return _json_seguro(valor.item())
    if hasattr(valor, "a_dict"):          # Georreferencia
        return _json_seguro(valor.a_dict())
    return str(valor)


def cargar_zonas(m, ruta):
    """Carga un archivo de 'Guardar zonas' de la app (mismo formato y mismas reglas)."""
    with open(ruta, encoding="utf-8") as f:
        datos = json.load(f)
    m.borrar_zonas()
    nombres = datos.get("nombres") or []
    limites = datos.get("limites") or []
    roles = datos.get("roles") or []
    m._roles_web = []
    for i, (zona, tipo) in enumerate(zip(datos["zonas"], datos["tipos"])):
        if tipo not in ("acumulativa", "dinamica"):
            continue
        if len(zona) == 4 and all(isinstance(v, (int, float)) for v in zona):
            x, y, w, h = zona                                  # formato antiguo: rectangulo
            puntos = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
        else:
            puntos = [(float(p[0]), float(p[1])) for p in zona]
        if len(puntos) < 3:
            continue
        nombre = nombres[i] if i < len(nombres) and isinstance(nombres[i], str) else ""
        m.agregar_zona(puntos, tipo, nombre)
        m._roles_web.append(roles[i] if i < len(roles) and isinstance(roles[i], str) else "")
        if i < len(limites) and isinstance(limites[i], (int, float)):
            m.definir_limite_zona(len(m.zonas) - 1, limites[i])
    if isinstance(datos.get("limite_general"), (int, float)):
        m.limite_general = datos["limite_general"]
    if datos.get("georreferencia"):
        import georreferencia
        m.usar_georef(georreferencia.Georreferencia.desde_dict(datos["georreferencia"]))
    return len(m.zonas)


def calibrar_automatico(m, largo=15.0):
    """Igual que la app: si el video no tiene calibracion, se calibra con el largo del camion
    (15 m por defecto; en la web el visitante puede indicar otro)."""
    import georreferencia
    medida = m.medir_camiones()
    if not medida or medida["n"] < 3:
        return False
    escala = largo / medida["largo_px"]
    ancho, alto = m.resolucion_original
    info = {"fuente": f"Automática aproximada: largo del camión {largo:g} m (\u00b1 7 %)", "largo_m": largo,
            "ancho_m": None, "incertidumbre_escala_pct": 7.0,
            "largo_px": round(medida["largo_px"], 1), "camiones_medidos": medida["n"],
            "precision_m": round(max(1.5 * escala, 0.05), 2), "distancias": []}
    m.usar_georef(georreferencia.plano_local(ancho, alto, escala, 0, 0, info))
    return True


def _escribir_progreso(ruta, avance, falta_s):
    """Deja el avance en un archivo JSON (lo lee el servidor de analisis de la web)."""
    temporal = ruta + ".tmp"
    with open(temporal, "w", encoding="utf-8") as f:
        json.dump({"avance": round(float(avance), 4), "falta_s": round(float(falta_s), 1)}, f)
    os.replace(temporal, ruta)


def revisar_video(ruta, destino):
    """Copia el video a la carpeta de la web y avisa si el navegador podria no reproducirlo."""
    import cv2
    cap = cv2.VideoCapture(ruta)
    codigo = int(cap.get(cv2.CAP_PROP_FOURCC)) if cap.isOpened() else 0
    cap.release()
    fourcc = "".join(chr((codigo >> 8 * k) & 0xFF) for k in range(4)).strip("\x00 ").lower()
    shutil.copyfile(ruta, destino)
    mb = os.path.getsize(destino) / 1e6
    avisos = []
    if fourcc and fourcc not in ("avc1", "h264", "x264", "avc3"):
        avisos.append(f"El video usa el formato '{fourcc}'. Los navegadores reproducen mejor H.264 "
                      "(avc1). Si en la web no se ve, avísale a Claude para convertirlo.")
    if mb > LIMITE_ARCHIVO_MB:
        avisos.append(f"El video pesa {mb:.1f} MB: GitHub Pages lo acepta, Cloudflare Pages no "
                      f"(máximo {LIMITE_ARCHIVO_MB} MB por archivo).")
    return fourcc or "?", mb, avisos


def _camiones_para_calibrar(m, t):
    """Camiones medidos en el cuadro actual (para el dialogo de calibracion de la web)."""
    lista = m.camiones_en_cuadro(m.ultimo_limpio)
    if not lista:
        return None
    return {"t": round(t, 3), "cuadro": m.contador_frames,
            "camiones": [{"poli": [[_r1(x), _r1(y)] for x, y in c["poli"]], "largo": _r1(c["largo"]),
                          "ancho": _r1(c["ancho"]), "borde": bool(c["borde"]), "usado": bool(c["usado"]),
                          "motivo": c["motivo"]} for c in lista]}


def _metros_exactos(reg, m):
    """Distancia en metros sin redondear (la misma suma de RegistroDatos._distancia_metros)."""
    if reg.georef is None:
        return None
    total = 0.0
    for x1, y1, x2, y2 in m["segmentos"]:
        e1, n1 = reg.georef.a_coordenadas(x1, y1)
        e2, n2 = reg.georef.a_coordenadas(x2, y2)
        total += math.hypot(e2 - e1, n2 - n1)
    return round(total, 4)


def fila_cuadro(m):
    """Fila de demo.json del cuadro que el motor acaba de procesar:
    [n, inferido, activos, filas, crudas] (ver "columnas_camion" y "columnas_cruda")."""
    inferido = 1 if m._debe_inferir() else 0          # en este cuadro corrio YOLO
    estados = m.gestor.estados if inferido else {}
    filas = []
    for pid, (x, y, w, h) in m.camiones_visibles:
        kmh = m.velocidades.get(pid)
        # Estado del cuadro: D = medido por YOLO, P = protegido (cola), E = estimado (tapado)
        estado = {"DETECTADO": "D", "PROTEGIDO": "P", "PREDICHO": "E"}.get(estados.get(pid), "")
        poli = m.poligonos.get(pid)
        filas.append([pid, int(x), int(y), int(w), int(h), None if kmh is None else round(kmh, 1),
                      estado, [round(float(v), 3) for v in poli.reshape(-1)] if poli is not None else None])
    # Cajas "crudas" con las que el motor cuenta en las zonas (solo cuadros con YOLO).
    crudas = list(getattr(m, "_tracks_exportar", None) or []) if inferido else []
    return [m.contador_frames, inferido, m.camiones_activos(), filas, crudas]


def datos_demo(m, nombre, video, codec, nombre_modo, skip, zonas, cuadros, conteos, medidas):
    """Todo lo que va en demo.json."""
    import deteccion_camiones as dc
    import motor as modulo_motor
    return {
        "version": 1,
        "nombre": nombre,
        "video": video,
        "archivo_video": "video.mp4",
        "codec": codec,
        "fps": m.fps,
        "total_frames": m.contador_frames,
        "duracion_s": m.contador_frames / m.fps,
        "resolucion": list(m.resolucion_original),
        "trabajo": [dc.ANCHO_VISUAL, dc.ALTO_VISUAL],
        "modo": nombre_modo,
        "skip_frames": skip,
        "dispositivo": "GPU" if str(m.dispositivo).startswith("cuda") else "CPU",
        "generado": time.strftime("%Y-%m-%d %H:%M"),
        "calibracion": m.georef.a_dict() if m.georef is not None else None,
        "zonas": zonas,
        "limite_general": m.limite_general,
        "parametros": {
            "umbral_entrada_zona": modulo_motor.UMBRAL_ENTRADA_ZONA,
            "umbral_salida_zona": modulo_motor.UMBRAL_SALIDA_ZONA,
            "filtro_segundos": dc.FILTRO_SEGUNDOS,
            "segundos_estado_inicial": modulo_motor.SEGUNDOS_ESTADO_INICIAL,
            "segundos_sin_velocidad": modulo_motor.SEGUNDOS_SIN_VELOCIDAD,
        },
        "columnas_camion": ["id", "x", "y", "w", "h", "kmh", "estado", "poligono"],
        "columnas_cruda": ["id", "x", "y", "w", "h"],
        "cuadros": cuadros,
        "conteos": conteos,
        "alertas": sorted(m.alertas, key=lambda a: a.get("tiempo_s", 0)),
        "camiones_calibracion": medidas,
    }


def datos_dashboard(m):
    """Lo mismo que recibe reporte_excel.py, mas lo que calcula para el Excel
    (detenciones, reparto del tiempo, ocupacion por intervalos y hallazgos)."""
    import reporte_excel
    reg = m.registro
    tray = reg._trayectorias_georef()
    d = reg._datos_reporte(tray)
    calc = reporte_excel._Datos(d)
    paso, zonas_ocup, filas_ocup = calc.ocupacion_intervalos()
    salida = {k: v for k, v in d.items() if k not in ("trayectorias_calculo", "georef")}
    salida.update({
        "calibracion": reg.georef.a_dict() if reg.georef is not None else None,
        "detenciones": calc.detenciones,
        "reparto_tiempo": calc.reparto_tiempo(),
        "ocupacion_intervalos": {"paso_s": paso, "zonas": zonas_ocup, "filas": filas_ocup},
        "hallazgos": reporte_excel._hallazgos(calc),
        "salidas_imagen": calc.salidas,
        "ingresos_imagen": calc.ingresos,
        "ejes": {"x": calc.eje_x, "y": calc.eje_y, "etiquetas": list(calc.etiquetas_xy)},
        "parametros": [[str(k), v if isinstance(v, (int, float)) else str(v)] for k, v in reg._parametros()],
        "detencion_minima_s": reporte_excel.DETENCION_MINIMA_S,
        "tolerancia_movimiento_s": reporte_excel.TOLERANCIA_MOVIMIENTO_S,
        "movimiento_minimo_vel_s": reporte_excel.MOVIMIENTO_MINIMO_VEL_S,
        # Tiempos y distancias acumulados de cada camion en cada muestra (cada 0.5 s), tal como
        # los lleva RegistroDatos: permiten ver los resultados "hasta" cualquier momento.
        "columnas_acumulados": ["cuadro", "id", "t_visible", "t_detenido", "t_movimiento",
                                "distancia_px", "distancia_m"],
        "acumulados": list(getattr(reg, "_acumulados", [])) + [
            # Valores finales (los mismos del Excel), al ultimo cuadro analizado.
            [reg.ultimo_frame, pid, round(m["t_visible"], 6), round(m["t_detenido"], 6), round(m["t_movimiento"], 6),
             round(m["distancia"], 1), _metros_exactos(reg, m)]
            for pid, m in sorted(reg.camiones.items())],
    })
    return salida


def exportar(args):
    os.chdir(CARPETA)
    import deteccion_camiones as dc
    import motor as modulo_motor

    ruta_video = os.path.abspath(args.video)
    if not os.path.exists(ruta_video):
        sys.exit(f"No se encontró el video: {ruta_video}")
    nombre_modo, skip = MODOS[_sin_tildes(args.modo)]
    slug = args.nombre or _sin_tildes(os.path.splitext(os.path.basename(ruta_video))[0])
    carpeta_web = os.path.abspath(args.salida)
    destino = os.path.join(carpeta_web, "datos", slug)
    os.makedirs(destino, exist_ok=True)

    print("=" * 64)
    print(" EXPORTAR DEMO PARA LA WEB  ·  Laboratorio de Software Minero - UNI")
    print("=" * 64)
    m = modulo_motor.Motor(args.modelo)
    print("Cargando el modelo...")
    m.cargar_modelo()
    m.skip_frames = skip
    m.abrir_video(ruta_video)
    if args.zonas:
        print(f"Zonas cargadas: {cargar_zonas(m, args.zonas)} (de {args.zonas})")
    if args.limite is not None:
        m.limite_general = args.limite if args.limite > 0 else None
    origen_calib = "la guardada junto al video" if m.georef is not None else None
    if m.georef is None and calibrar_automatico(m, args.largo_camion):
        origen_calib = f"automática (camiones de {args.largo_camion:g} m)"
    print(f"Video: {os.path.basename(ruta_video)}  ·  {m.resolucion_original[0]}x{m.resolucion_original[1]}"
          f"  ·  {m.fps:.2f} fps  ·  {_hms(m.duracion())}")
    print(f"Modo de análisis: {nombre_modo}  ·  Dispositivo: {'GPU' if str(m.dispositivo).startswith('cuda') else 'CPU'}")
    print(f"Calibración: {origen_calib or 'sin calibrar (solo píxeles)'}")
    print(f"Límite general: {m.limite_general or 'sin límite'} km/h")
    print("-" * 64)

    roles = list(getattr(m, "_roles_web", [])) + [""] * len(m.zonas)
    zonas = [{"puntos": [list(p) for p in z], "tipo": t, "nombre": n, "limite": l, "rol": r}
             for z, t, n, l, r in zip(m.zonas, m.tipos, m.nombres, m.limites, roles)]
    cuadros, conteos, medidas = [], [], []
    ultimo_conteo = None
    proxima_medida = 0.0
    inicio = time.time()
    ultimo_aviso = 0.0
    while True:
        frame = m.siguiente()
        if frame is None:
            break
        n = m.contador_frames
        t = m.tiempo_actual()
        cuadros.append(fila_cuadro(m))
        valores = [v for _, _, v in m.conteos()]
        if valores != ultimo_conteo:
            conteos.append([n, valores])
            ultimo_conteo = valores
        if t >= proxima_medida:
            proxima_medida = t + SEGUNDOS_ENTRE_MEDIDAS
            med = _camiones_para_calibrar(m, t)
            if med:
                medidas.append(med)
        ahora = time.time()
        if ahora - ultimo_aviso > 2.0 or m.terminado:
            ultimo_aviso = ahora
            velocidad = n / max(ahora - inicio, 1e-6)
            falta = (m.total_frames - n) / max(velocidad, 1e-6) if m.total_frames else 0
            print(f"\r  {m.progreso() * 100:5.1f} %  ·  {_hms(t)} de {_hms(m.duracion())}  ·  "
                  f"{velocidad:4.1f} cuadros/s  ·  faltan ~{_hms(falta)}   ", end="", flush=True)
            if args.progreso:                          # para el servidor de la web (Modal)
                _escribir_progreso(args.progreso, m.progreso(), falta)
    print(f"\r  100.0 %  ·  análisis terminado en {_hms(time.time() - inicio)}." + " " * 30)

    print("Guardando archivos para la web...")
    fourcc, mb, avisos_video = revisar_video(ruta_video, os.path.join(destino, "video.mp4"))
    demo = datos_demo(m, slug, os.path.basename(ruta_video), fourcc, nombre_modo, skip, zonas,
                      cuadros, conteos, medidas)
    with open(os.path.join(destino, "demo.json"), "w", encoding="utf-8") as f:
        json.dump(_json_seguro(demo), f, ensure_ascii=False, separators=(",", ":"))

    try:
        tablero = datos_dashboard(m)
        with open(os.path.join(destino, "resultados.json"), "w", encoding="utf-8") as f:
            json.dump(_json_seguro(tablero), f, ensure_ascii=False, separators=(",", ":"))
    except Exception as error:                       # el dashboard nunca debe frenar la demo
        print(f"Aviso: no se pudieron guardar los datos del dashboard ({error}).")

    with tempfile.TemporaryDirectory() as tmp:
        ruta_excel = m.exportar(tmp)
        if ruta_excel:
            shutil.copyfile(ruta_excel, os.path.join(destino, "reporte.xlsx"))

    # La web usa ESTOS MISMOS archivos del proyecto: reporte_excel.py para el Excel del visitante
    # y el motor completo para "Analizar mi video" en la computadora del visitante.
    # Se copian a web\py para que siempre use la version actual del proyecto.
    os.makedirs(os.path.join(carpeta_web, "py"), exist_ok=True)
    for archivo in ARCHIVOS_WEB:
        try:
            shutil.copyfile(os.path.join(CARPETA, archivo), os.path.join(carpeta_web, "py", archivo))
        except OSError as error:
            print(f"Aviso: no se pudo copiar {archivo} a la web ({error}).")

    ruta_catalogo = os.path.join(carpeta_web, "datos", "catalogo.json")
    catalogo = []
    if os.path.exists(ruta_catalogo):
        try:
            with open(ruta_catalogo, encoding="utf-8") as f:
                catalogo = json.load(f).get("videos", [])
        except (OSError, ValueError):
            catalogo = []
    catalogo = [v for v in catalogo if v.get("nombre") != slug]
    catalogo.insert(0, {"nombre": slug, "titulo": os.path.basename(ruta_video),
                        "duracion_s": round(demo["duracion_s"], 1), "camiones": len(m.registro.camiones),
                        "generado": demo["generado"]})
    with open(ruta_catalogo, "w", encoding="utf-8") as f:
        json.dump({"videos": catalogo}, f, ensure_ascii=False, indent=2)

    tam = sum(os.path.getsize(os.path.join(destino, a)) for a in os.listdir(destino)) / 1e6
    print("-" * 64)
    print(f"Listo. Camiones seguidos: {len(m.registro.camiones)}  ·  avisos: {len(m.alertas)}")
    print(f"Archivos en: {destino}  ({tam:.1f} MB en total)")
    for aviso in avisos_video:
        print(f"ATENCIÓN: {aviso}")
    print("Para verla:  cd web   y luego   python servidor_local.py   (abre http://localhost:8000)")
    m.cerrar()


def _instalar_registro_de_tracks():
    """Sin modificar motor.py ni deteccion_camiones.py, anota (1) las cajas con las que el motor
    cuenta en las zonas (envolviendo Motor._contar) y (2) los tiempos y distancias acumulados de
    cada camion en cada muestra de RegistroDatos (envolviendo RegistroDatos.registrar)."""
    import motor as modulo_motor
    original = modulo_motor.Motor._contar

    def _contar(self, tracks):
        self._tracks_exportar = [[pid, int(c[0]), int(c[1]), int(c[2]), int(c[3])] for pid, c in tracks]
        return original(self, tracks)

    modulo_motor.Motor._contar = _contar

    import math as _math
    import deteccion_camiones as dc
    original_registrar = dc.RegistroDatos.registrar

    def registrar(self, frame_n, tracks, estados, records, estado_zona):
        muestrear = (self.ultimo_muestreo is None or frame_n - self.ultimo_muestreo >= self.frames_muestreo)
        salida = original_registrar(self, frame_n, tracks, estados, records, estado_zona)
        if muestrear:
            filas = self.__dict__.setdefault("_acumulados", [])
            hechos = self.__dict__.setdefault("_segmentos_medidos", {})
            metros = self.__dict__.setdefault("_metros", {})
            for pid, _ in tracks:
                m = self.camiones.get(pid)
                if m is None:
                    continue
                if self.georef is not None:            # misma suma que _distancia_metros
                    for x1, y1, x2, y2 in m["segmentos"][hechos.get(pid, 0):]:
                        e1, n1 = self.georef.a_coordenadas(x1, y1)
                        e2, n2 = self.georef.a_coordenadas(x2, y2)
                        metros[pid] = metros.get(pid, 0.0) + _math.hypot(e2 - e1, n2 - n1)
                    hechos[pid] = len(m["segmentos"])
                filas.append([frame_n, pid, round(m["t_visible"], 3), round(m["t_detenido"], 3),
                              round(m["t_movimiento"], 3), round(m["distancia"], 1),
                              round(metros.get(pid, 0.0), 2) if self.georef is not None else None])
        return salida

    dc.RegistroDatos.registrar = registrar


def main():
    p = argparse.ArgumentParser(description="Exporta un video analizado para la web (modo demostración).")
    p.add_argument("--video", default="SIMULACIÓN.mp4", help="video a analizar (por defecto SIMULACIÓN.mp4)")
    p.add_argument("--zonas", default=None, help="archivo de 'Guardar zonas' de la app (opcional)")
    p.add_argument("--modo", default="Precision", help="Precision, Equilibrado o Rapido (por defecto Precision)")
    p.add_argument("--limite", type=float, default=None, help="límite general en km/h (opcional)")
    p.add_argument("--modelo", default="best_obb_v2.pt", help="modelo YOLO (por defecto best_obb_v2.pt)")
    p.add_argument("--nombre", default=None, help="nombre corto de la demo (por defecto, el del video)")
    p.add_argument("--salida", default="web", help="carpeta de la página web (por defecto web)")
    p.add_argument("--largo-camion", type=float, default=15.0,
                   help="largo real del camión en metros para la calibración automática (por defecto 15)")
    p.add_argument("--progreso", default=None, help="archivo JSON donde dejar el avance (lo usa el servidor web)")
    args = p.parse_args()
    if _sin_tildes(args.modo) not in MODOS:
        sys.exit("El modo debe ser Precision, Equilibrado o Rapido.")
    os.chdir(CARPETA)
    sys.path.insert(0, CARPETA)
    _instalar_registro_de_tracks()
    try:
        exportar(args)
    except KeyboardInterrupt:
        print("\nCancelado por el usuario. No se guardó nada nuevo.")


if __name__ == "__main__":
    main()
