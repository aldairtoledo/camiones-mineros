"""Analisis de un video DENTRO del navegador (boton "Analizar mi video" -> "En mi computadora").

La pagina corre YOLO (con la tarjeta de video del visitante) y ByteTrack en JavaScript, y le
pasa a este archivo, cuadro por cuadro, los camiones que encontro. Aqui se usa el MISMO
motor.py de la app de escritorio (identidades de la flota, velocidades, avisos, registro de
datos) y las mismas funciones de exportar_demo.py, asi que el resultado es el mismo que da
la laptop con exportar_demo.py.

Corre con Pyodide (Python en el navegador). Como en el navegador no hay OpenCV, PyTorch ni
Ultralytics, se ponen "reemplazos" minimos: el motor no los necesita para recibir camiones
ya detectados (no lee el video ni dibuja nada).
"""
import json
import math
import sys
import types

import numpy as np


# ---------------------------------------------------------------- reemplazos
def _reemplazo_cv2():
    cv2 = types.ModuleType("cv2")
    for nombre, valor in dict(CAP_PROP_FPS=5, CAP_PROP_FRAME_COUNT=7, CAP_PROP_POS_FRAMES=1,
                              CAP_PROP_FRAME_WIDTH=3, CAP_PROP_FRAME_HEIGHT=4, LINE_AA=16,
                              FONT_HERSHEY_SIMPLEX=0, FONT_HERSHEY_TRIPLEX=4, COLOR_BGR2GRAY=6,
                              EVENT_LBUTTONDOWN=1, EVENT_MOUSEMOVE=0, EVENT_LBUTTONUP=4,
                              EVENT_RBUTTONDOWN=2, WINDOW_NORMAL=0).items():
        setattr(cv2, nombre, valor)

    def nada(*_a, **_k):
        return None

    for nombre in ("line", "rectangle", "putText", "circle", "polylines", "addWeighted", "imshow",
                   "namedWindow", "resizeWindow", "setMouseCallback", "destroyWindow", "destroyAllWindows"):
        setattr(cv2, nombre, nada)
    cv2.getTextSize = lambda *_a, **_k: ((0, 0), 0)
    cv2.waitKey = lambda *_a, **_k: -1
    # El motor no mira las imagenes: basta un cuadro diminuto.
    cv2.resize = lambda img, tam, *a, **k: np.zeros((1, 1, 3), np.uint8)

    def boundingRect(pts):
        p = np.asarray(pts).reshape(-1, 2)
        x0, y0 = int(p[:, 0].min()), int(p[:, 1].min())
        return x0, y0, int(p[:, 0].max()) - x0 + 1, int(p[:, 1].max()) - y0 + 1

    def contourArea(pts):
        p = np.asarray(pts, np.float64).reshape(-1, 2)
        x, y = p[:, 0], p[:, 1]
        return float(abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) / 2)

    def pointPolygonTest(contorno, punto, medir):
        p = np.asarray(contorno, np.float64).reshape(-1, 2)
        x, y = float(punto[0]), float(punto[1])
        dentro, borde, dmin = False, False, math.inf
        for i in range(len(p)):
            x1, y1 = p[i]
            x2, y2 = p[(i + 1) % len(p)]
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                dentro = not dentro
            dx, dy = x2 - x1, y2 - y1
            t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
            d = math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))
            dmin = min(dmin, d)
            borde = borde or d == 0
        if not medir:
            return 0.0 if borde else (1.0 if dentro else -1.0)
        return dmin if dentro else -dmin

    def getAffineTransform(origen, destino):
        a = np.hstack([np.asarray(origen, np.float64).reshape(3, 2), np.ones((3, 1))])
        return np.linalg.solve(a, np.asarray(destino, np.float64).reshape(3, 2)).T

    def fillPoly(*_a, **_k):
        raise NotImplementedError("Las zonas se cuentan en la pagina (recalculo.js).")

    for f in (boundingRect, contourArea, pointPolygonTest, getAffineTransform, fillPoly):
        setattr(cv2, f.__name__, f)
    return cv2


def instalar_reemplazos(asignacion=None):
    """Pone los reemplazos de cv2, torch, ultralytics y (si falta) scipy. 'asignacion' es la
    funcion de asignacion optima (la de scipy o la de la pagina, que da el mismo resultado)."""
    sys.modules.setdefault("cv2", _reemplazo_cv2())
    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(is_available=lambda: False, get_device_name=lambda *_: "")
    sys.modules.setdefault("torch", torch)
    ultra = types.ModuleType("ultralytics")
    ultra.YOLO = lambda *a, **k: None
    sys.modules.setdefault("ultralytics", ultra)
    try:
        import scipy.optimize  # noqa: F401  (en la laptop, para probar)
    except ImportError:
        scipy = types.ModuleType("scipy")
        opt = types.ModuleType("scipy.optimize")

        def linear_sum_assignment(matriz):
            m = np.asarray(matriz, np.float64)
            filas, cols = asignacion(m.tolist(), m.shape[0], m.shape[1])
            return np.asarray(filas, np.int64), np.asarray(cols, np.int64)

        opt.linear_sum_assignment = linear_sum_assignment
        scipy.optimize = opt
        sys.modules["scipy"], sys.modules["scipy.optimize"] = scipy, opt


# ---------------------------------------------------------------- resultados de YOLO falsos
class _Tensor:
    """Lo poco que motor.py usa de un tensor de PyTorch."""
    def __init__(self, a):
        self.a = np.asarray(a)

    def int(self):
        return _Tensor(self.a.astype(np.int64))

    def cpu(self):
        return self

    def numpy(self):
        return self.a

    def tolist(self):
        return self.a.tolist()


class _Modelo:
    """Hace de model.track(): devuelve los camiones que la pagina encontro en este cuadro.
    Cada camion: [id, x1, y1, x2, y2, 8 valores del poligono] (cuadro de trabajo 800 x 600)."""
    def __init__(self):
        self.camiones = None

    def track(self, **_k):
        filas, self.camiones = self.camiones, None
        if filas is None:
            raise RuntimeError("La página no envió los camiones de este cuadro.")
        obb = types.SimpleNamespace(id=None, xyxy=None, xyxyxyxy=None)
        if filas:
            obb.id = _Tensor([f[0] for f in filas])
            obb.xyxy = _Tensor(np.asarray([f[1:5] for f in filas], np.float32))
            obb.xyxyxyxy = _Tensor(np.asarray([f[5:13] for f in filas], np.float32).reshape(-1, 4, 2))
        return [types.SimpleNamespace(obb=obb)]


class _Video:
    """Hace de cv2.VideoCapture: el video lo lee la pagina, aqui solo se cuentan los cuadros."""
    def read(self):
        return True, np.zeros((1, 1, 3), np.uint8)

    def set(self, *_a):
        return True

    def release(self):
        pass


# ---------------------------------------------------------------- analisis
class Analisis:
    def __init__(self, nombre_video, ancho, alto, fps, total_cuadros, modo, skip, largo_camion,
                 polis_primer_cuadro):
        import exportar_demo as ed
        import motor as modulo_motor
        ed._instalar_registro_de_tracks()
        self.ed = ed
        m = modulo_motor.Motor("modelo")
        m.cap, m.model, m.video_path = _Video(), _Modelo(), nombre_video
        m.fps, m.total_frames = float(fps), int(total_cuadros)
        m.resolucion_original = (int(ancho), int(alto))
        m.primer_frame = np.zeros((1, 1, 3), np.uint8)
        m.skip_frames = skip
        self._polis = polis_primer_cuadro
        m.camiones_en_cuadro = self._camiones_en_cuadro
        m.dibujar_zonas = lambda frame: None
        import deteccion_camiones as dc
        dc.dibujar_camiones = lambda *a, **k: None
        self.m, self.nombre, self.modo, self.skip = m, nombre_video, modo, skip
        self.calibracion = None
        if ed.calibrar_automatico(m, largo_camion):
            self.calibracion = f"automática (camiones de {largo_camion:g} m)"
        self.cuadros, self.conteos, self.medidas = [], [], []
        self._ultimo_conteo = None
        self._proxima_medida = 0.0

    def _camiones_en_cuadro(self, _frame):
        """Como Motor.camiones_en_cuadro, con los poligonos que YOLO encontro en la pagina."""
        import motor as modulo_motor
        import deteccion_camiones as dc
        polis, self._polis = self._polis, None
        if not polis:
            return []
        ancho, alto = self.m.resolucion_original
        fx, fy = ancho / dc.ANCHO_VISUAL, alto / dc.ALTO_VISUAL
        mb = modulo_motor.MARGEN_BORDE_PX
        camiones = []
        for poli in polis:
            p = np.asarray(np.asarray(poli, np.float32), dtype=float).reshape(-1, 2)
            if len(p) != 4:
                continue
            borde = bool((p[:, 0] <= mb).any() or (p[:, 1] <= mb).any() or
                         (p[:, 0] >= dc.ANCHO_VISUAL - 1 - mb).any() or (p[:, 1] >= dc.ALTO_VISUAL - 1 - mb).any())
            p = p * [fx, fy]
            lados = sorted([math.hypot(*(p[1] - p[0])), math.hypot(*(p[2] - p[1]))])
            if lados[0] < 2:
                continue
            camiones.append({"poli": p.tolist(), "largo": lados[1], "ancho": lados[0], "borde": borde})
        return modulo_motor.clasificar_camiones(camiones)

    def quiere_medida(self, n):
        """¿La pagina debe mandar los poligonos de YOLO del cuadro n (para calibrar en la web)?"""
        return n / self.m.fps >= self._proxima_medida

    def paso(self, camiones_json=None, polis_json=None):
        """Procesa el siguiente cuadro. camiones_json: lo que encontro ByteTrack (solo en los
        cuadros con YOLO); polis_json: poligonos de YOLO si quiere_medida(n)."""
        m = self.m
        if camiones_json is not None:
            m.model.camiones = json.loads(camiones_json)
        self._polis = json.loads(polis_json) if polis_json else None
        if m.siguiente() is None:
            return None
        n, t = m.contador_frames, m.tiempo_actual()
        fila = self.ed.fila_cuadro(m)
        self.cuadros.append(fila)
        valores = [v for _, _, v in m.conteos()]
        if valores != self._ultimo_conteo:
            self.conteos.append([n, valores])
            self._ultimo_conteo = valores
        if t >= self._proxima_medida:
            self._proxima_medida = t + self.ed.SEGUNDOS_ENTRE_MEDIDAS
            med = self.ed._camiones_para_calibrar(m, t)
            if med:
                self.medidas.append(med)
        self._polis = None
        return fila

    def fila_json(self, fila):
        return json.dumps(self.ed._json_seguro(fila), separators=(",", ":"))

    def terminar(self, dispositivo="Tu computadora"):
        """demo.json y resultados.json (como texto JSON), igual que exportar_demo.py."""
        ed, m = self.ed, self.m
        m.terminado = True
        demo = ed.datos_demo(m, ed._sin_tildes(self.nombre.rsplit(".", 1)[0]), self.nombre, "local",
                             self.modo, self.skip, [], self.cuadros, self.conteos, self.medidas)
        demo["dispositivo"] = dispositivo
        demo["calibracion_origen"] = self.calibracion
        try:
            tablero = ed._json_seguro(ed.datos_dashboard(m))
        except Exception as error:                   # el dashboard nunca debe frenar el analisis
            print(f"Aviso: no se pudieron armar los resultados ({error}).")
            tablero = None
        return json.dumps({"demo": ed._json_seguro(demo), "tablero": tablero},
                          ensure_ascii=False, separators=(",", ":"))
