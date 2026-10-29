import cv2
import math
import os
import time
from collections import defaultdict
from datetime import datetime, timedelta

import numpy as np
import torch
from scipy.optimize import linear_sum_assignment
from ultralytics import YOLO


# =========================
# PARAMETROS EXPERIMENTALES
# =========================
# Funciona con el modelo de cajas rectas (best.pt) o con el de cajas rotadas (best_obb.pt).
MODEL_PATH = "best_obb_v2.pt"
VIDEO_PATH = "SIMULACIÓN.mp4"
IMGSZ_DETECCION = 640   # usa el mismo valor con el que entrenaste
CONF_DETECCION = 0.25
IOU_NMS = 0.70
# Cada cuantos cuadros se analiza con YOLO (acepta decimales):
# 1 = todos (maxima precision) | 1.5 = 2 de cada 3 | 2 = 1 de cada 2 | 3 = 1 de cada 3
SKIP_FRAMES = 1.5
# Maximo de camiones A LA VEZ en la imagen (tope de seguridad; los numeros no se reciclan).
MAX_CAMIONES = 40
# Un camion que sale por el borde de la imagen queda cerrado: si luego entra un camion por
# el borde, recibe un numero NUEVO (un camion real tarda mucho mas en volver).
# Tiempo sin verlo junto al borde para dar la salida por confirmada:
SEGUNDOS_CONFIRMAR_SALIDA = 1.0
# Un camion nuevo recien recibe numero si se sigue viendo este tiempo (evita "fantasmas":
# cajas duplicadas de un instante, por ejemplo cuando un camion maniobra junto a la cola).
SEGUNDOS_CONFIRMAR_ENTRADA = 0.5
# Un camion perdido en medio de la imagen (no anclado) se da por perdido tras este tiempo.
SEGUNDOS_OLVIDAR_PERDIDO = 60.0
TRACKER_CONFIG = "bytetrack_minas.yaml"
TRACK_THRESH = 0.50
TRACK_LOW_THRESH = 0.10
MATCH_THRESH = 0.85
TRACK_BUFFER_FRAMES = 45
MOSTRAR_CAJAS_EN_FRAMES_OMITIDOS = True
# Suavizado solo visual de las cajas (0 = sin suavizar, 0.8 = muy suave).
SUAVIZADO_VISUAL = 0.5
ANCHO_VISUAL = 800
ALTO_VISUAL = 600
# Tamano de la ventana principal (debe entrar en tu pantalla).
ANCHO_VENTANA = 1200
ALTO_VENTANA = 900

# Conteo por zonas: fraccion del area de la caja del camion que esta
# dentro de la zona. Entra al superar UMBRAL_ENTRADA y sale al bajar de
# UMBRAL_SALIDA (la diferencia evita parpadeos en el borde).
UMBRAL_ENTRADA = 0.20   # 20% de la caja dentro -> "dentro"
UMBRAL_SALIDA = 0.05    # menos del 5% dentro -> "fuera"
FILTRO_SEGUNDOS = 0.15  # tiempo que debe sostenerse el cambio para confirmarlo
SEGUNDOS_INICIALES_SIN_CONTAR = 2.0

# Proteccion de la cola: cuando un camion en movimiento pasa a menos de
# MARGEN_PERTURBACION_PX de un camion detenido, este queda "congelado"
# (mantiene su caja e ID) mientras dure el cruce y SEGUNDOS_POST_PERTURBACION
# despues. Solo acepta detecciones que coincidan casi exactamente con el.
MARGEN_PERTURBACION_PX = 30
SEGUNDOS_POST_PERTURBACION = 0.7
IOU_MIN_PROTEGIDO = 0.40

# Exportacion de datos a Excel (requiere: pip install pandas openpyxl).
# Las coordenadas se guardan en pixeles de la resolucion ORIGINAL del video.
EXPORTAR_DATOS = True
CARPETA_SALIDA = "resultados"
# Cada cuanto se guarda una fila de trayectoria por camion (0 = cada frame procesado).
INTERVALO_MUESTREO_S = 0.5
# Velocidad (px/s, resolucion original) por debajo de la cual el camion se considera DETENIDO.
UMBRAL_MOVIMIENTO_PX_S = 15.0
# Saltos de posicion mas rapidos que esto se consideran ruido y no suman distancia.
VELOCIDAD_MAX_PX_S = 1500.0

# Leyenda de zonas: una sola linea horizontal, compacta y semitransparente.
# Puedes colocarla a mano en la ventana de zonas con la tecla 'l' (tiene prioridad).
# Si no la colocas, "auto" elige la esquina mas libre (sin panel, zonas, carreteras ni camiones);
# tambien puedes fijarla con "sup_izq", "sup_der", "inf_izq" o "inf_der".
POSICION_LEYENDA = "auto"
# Panel de control: barra horizontal compacta. Se coloca a mano con la tecla 'p'
# en la ventana de zonas; si no, "auto" o una esquina fija, igual que la leyenda.
POSICION_PANEL = "auto"
OPACIDAD_PANEL = 0.75
OPACIDAD_LEYENDA = 0.70          # 0 = invisible, 1 = fondo solido
SEGUNDOS_REEVALUAR_LEYENDA = 3.0 # cada cuanto revisa si otra esquina esta mas libre
MARGEN_LEYENDA_PX = 8

# Estilo de las cajas de deteccion: un solo color para todos (BGR).
COLOR_CAJA = (255, 255, 0)      # cian
GROSOR_CAJA = 1
COLOR_TEXTO_ETIQUETA = (0, 0, 0)
ESCALA_TEXTO_ETIQUETA = 0.4


def elegir_dispositivo():
    if torch.cuda.is_available():
        print(f"GPU CUDA detectada: {torch.cuda.get_device_name(0)}")
        return "cuda:0"
    print("GPU CUDA no disponible. Usando CPU.")
    return "cpu"


def configurar_bytetrack():
    contenido = (
        "tracker_type: bytetrack\n"
        f"track_high_thresh: {TRACK_THRESH}\n"
        f"track_low_thresh: {TRACK_LOW_THRESH}\n"
        f"new_track_thresh: {TRACK_THRESH}\n"
        f"track_buffer: {TRACK_BUFFER_FRAMES}\n"
        f"match_thresh: {MATCH_THRESH}\n"
        "fuse_score: true\n"
    )
    with open(TRACKER_CONFIG, "w", encoding="utf-8") as archivo:
        archivo.write(contenido)


def dibujar_rectangulo_punteado(img, pt1, pt2, color, espesor=1, largo_linea=10, espacio=5):
    x1, y1 = pt1
    x2, y2 = pt2
    for x in range(x1, x2, largo_linea + espacio):
        cv2.line(img, (x, y1), (min(x + largo_linea, x2), y1), color, espesor)
        cv2.line(img, (x, y2), (min(x + largo_linea, x2), y2), color, espesor)
    for y in range(y1, y2, largo_linea + espacio):
        cv2.line(img, (x1, y), (x1, min(y + largo_linea, y2)), color, espesor)
        cv2.line(img, (x2, y), (x2, min(y + largo_linea, y2)), color, espesor)


ELEMENTOS_MOVIBLES = ("leyenda", "panel")


def tam_elemento(estado, elemento):
    return estado["tam_leyenda"] if elemento == "leyenda" else medir_panel(estado["tipos"])


def rect_elemento(pos, w, h):
    """Rectangulo con esquina superior izquierda en pos, sin salirse de la imagen."""
    x1 = min(max(0, pos[0]), ANCHO_VISUAL - w)
    y1 = min(max(0, pos[1]), ALTO_VISUAL - h)
    return (x1, y1, x1 + w, y1 + h)


def colocar_elemento(estado, elemento, x, y):
    """Centra la leyenda o el panel en (x, y)."""
    w, h = tam_elemento(estado, elemento)
    x1, y1, _, _ = rect_elemento((x - w // 2, y - h // 2), w, h)
    estado[f"{elemento}_pos"] = (x1, y1)


def dibujar_zonas(event, x, y, flags, param):
    estado = param
    if estado["modo"] in ELEMENTOS_MOVIBLES:
        # Clic o arrastre: mueve el elemento. Clic derecho: vuelve a la ubicacion automatica.
        elemento = estado["modo"]
        if event == cv2.EVENT_LBUTTONDOWN:
            estado["dibujando"] = True
            colocar_elemento(estado, elemento, x, y)
        elif event == cv2.EVENT_MOUSEMOVE and estado["dibujando"]:
            colocar_elemento(estado, elemento, x, y)
        elif event == cv2.EVENT_LBUTTONUP:
            estado["dibujando"] = False
            nombre = "Leyenda colocada" if elemento == "leyenda" else "Panel colocado"
            print(f"-> {nombre} en {estado[f'{elemento}_pos']}.")
        elif event == cv2.EVENT_RBUTTONDOWN:
            estado[f"{elemento}_pos"] = None
            print(f"-> {elemento.capitalize()} en ubicacion automatica.")
        return
    if event == cv2.EVENT_LBUTTONDOWN:
        estado["dibujando"] = True
        estado["ix"], estado["iy"] = x, y
        estado["fx"], estado["fy"] = x, y
    elif event == cv2.EVENT_MOUSEMOVE and estado["dibujando"]:
        estado["fx"], estado["fy"] = x, y
    elif event == cv2.EVENT_LBUTTONUP:
        estado["dibujando"] = False
        estado["fx"], estado["fy"] = x, y
        x_min, y_min = min(estado["ix"], x), min(estado["iy"], y)
        ancho, alto = abs(estado["ix"] - x), abs(estado["iy"] - y)
        if ancho > 10 and alto > 10:
            estado["zonas"].append((x_min, y_min, ancho, alto))
            estado["tipos"].append(estado["modo"])
            print(f"-> Zona {len(estado['zonas'])} guardada como {estado['modo'].upper()}.")
    elif event == cv2.EVENT_RBUTTONDOWN and estado["zonas"]:
        estado["zonas"].pop()
        estado["tipos"].pop()


def centro_caja(caja):
    x, y, w, h = caja
    return x + w / 2, y + h / 2


def iou_cajas(caja_a, caja_b):
    ax, ay, aw, ah = caja_a
    bx, by, bw, bh = caja_b
    x1, y1 = max(ax, bx), max(ay, by)
    x2, y2 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def rects_se_cruzan(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    return ax1 < bx2 and bx1 < ax2 and ay1 < by2 and by1 < ay2


def contencion(interior, exterior):
    """Fraccion del area de 'interior' que queda dentro de 'exterior'."""
    ix, iy, iw, ih = interior
    ex, ey, ew, eh = exterior
    x1, y1 = max(ix, ex), max(iy, ey)
    x2, y2 = min(ix + iw, ex + ew), min(iy + ih, ey + eh)
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    return inter / max(1, iw * ih)


def expandir_caja(caja, margen):
    x, y, w, h = caja
    return (x - margen, y - margen, w + 2 * margen, h + 2 * margen)


def cajas_se_tocan(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return ax < bx + bw and bx < ax + aw and ay < by + bh and by < ay + ah


def clasificar_en_zona(caja, zona, tipo):
    """Devuelve 'dentro', 'fuera' o None (transicion: no cambia el estado).
    Se basa en la fraccion del area de la caja que queda dentro de la zona,
    para que el camion se cuente apenas empieza a entrar."""
    fraccion = contencion(caja, zona)
    if fraccion >= UMBRAL_ENTRADA:
        return "dentro"
    if fraccion <= UMBRAL_SALIDA:
        return "fuera"
    return None


class FleetIdentityManager:
    """
    Identidades 1, 2, 3... (cada camion nuevo recibe el siguiente numero).

    - Un camion que sale por el borde queda FUERA y su numero no se vuelve a usar:
      un camion que entra por el borde siempre recibe un numero nuevo.
    - Una deteccion que aparece en medio de la imagen es un camion que se perdio un
      momento (tapado, junto a otro): recupera su numero si hay uno perdido cerca.

    - Asignacion global con el algoritmo hungaro (posicion predicha, tamano, IoU).
    - Camiones QUIETOS (en cola) quedan "anclados": solo aceptan detecciones
      muy cerca de donde estan, asi un camion que pasa por su costado no
      puede robarles el numero.
    - Cajas FUSIONADAS: si una deteccion cubre a dos o mas camiones a la vez,
      no se usa para ninguno; ambos siguen con su posicion predicha hasta
      que YOLO los vuelva a separar.
    - Camiones PROTEGIDOS: si un camion en movimiento pasa cerca de uno
      anclado, el anclado se congela (caja, velocidad y ancla fijas) durante
      el cruce y un tiempo despues, para que las cajas deformadas por el
      cruce no le cambien el ID.
    """

    COSTE_INVALIDO = 1e6

    def __init__(self, max_camiones=8, distancia_base=120, distancia_max=400,
                 crecimiento_por_frame=4.0, size_ratio=2.0, bono_continuidad=0.15,
                 frames_prediccion_max=60, suavizado_velocidad=0.6,
                 frames_antes_de_forzar=3, velocidad_quieto=0.4, frames_para_anclar=15,
                 radio_anclado=20, frames_liberar_ancla=150, contencion_fusion=0.6,
                 max_frames_oculto=150, margen_perturbacion=30,
                 frames_post_perturbacion=20, iou_min_protegido=0.4,
                 frames_confirmar_salida=8, ancho=ANCHO_VISUAL, alto=ALTO_VISUAL,
                 frames_confirmar_fuera=30, frames_olvidar=1800, frames_confirmar_entrada=15):
        self.frames_confirmar_salida = frames_confirmar_salida
        self.ancho, self.alto = ancho, alto
        self.frames_confirmar_fuera = frames_confirmar_fuera
        self.frames_olvidar = frames_olvidar
        self.salidas = []               # (pid, frame) de cada camion que salio de la imagen
        self.frames_confirmar_entrada = frames_confirmar_entrada
        self.tentativos = []            # posibles camiones nuevos, aun sin numero
        self.primer_frame = None
        self.margen_perturbacion = margen_perturbacion
        self.frames_post_perturbacion = frames_post_perturbacion
        self.iou_min_protegido = iou_min_protegido
        self.max_camiones = max_camiones
        self.distancia_base = distancia_base
        self.distancia_max = distancia_max
        self.crecimiento_por_frame = crecimiento_por_frame
        self.size_ratio = size_ratio
        self.bono_continuidad = bono_continuidad
        self.frames_prediccion_max = frames_prediccion_max
        self.suavizado_velocidad = suavizado_velocidad
        self.frames_antes_de_forzar = frames_antes_de_forzar
        self.velocidad_quieto = velocidad_quieto
        self.frames_para_anclar = frames_para_anclar
        self.radio_anclado = radio_anclado
        self.frames_liberar_ancla = frames_liberar_ancla
        self.contencion_fusion = contencion_fusion
        self.max_frames_oculto = max_frames_oculto
        self.records = {}
        self.estados = {}
        self.internal_to_persistent = {}

    # ---------- utilidades ----------
    def _prediccion(self, r, frame_number):
        dt = min(max(1, frame_number - r["last_frame"]), self.frames_prediccion_max)
        return tuple(v + vel * dt for v, vel in zip(r["bbox"], r["velocity"]))

    def _anclado(self, r, frame_number):
        return (r["quieto"] >= self.frames_para_anclar
                and frame_number - r["last_frame"] <= self.frames_liberar_ancla)

    def _gate(self, r, frame_number):
        if self._anclado(r, frame_number):
            return self.radio_anclado
        perdidos = max(0, frame_number - r["last_frame"] - 1)
        return min(self.distancia_max, self.distancia_base + self.crecimiento_por_frame * perdidos)

    def _en_borde(self, caja, factor=0.6):
        """La caja esta junto al borde de la imagen (entrando o saliendo)."""
        x, y, w, h = caja
        m = max(6.0, factor * max(w, h))
        return x < m or y < m or x + w > self.ancho - m or y + h > self.alto - m

    def _saliendo(self, r, frame_number):
        """Camion perdido junto al borde que iba hacia afuera (o ya tocaba el borde)."""
        if r["bbox"] is None or self._anclado(r, frame_number) or not self._en_borde(r["bbox"]):
            return False
        x, y, w, h = r["bbox"]
        if x <= 2 or y <= 2 or x + w >= self.ancho - 2 or y + h >= self.alto - 2:
            return True                          # ya estaba cortado por el borde
        vx, vy = r["velocity"][:2]
        cx, cy = x + w / 2, y + h / 2
        # direccion hacia el borde mas cercano
        dist = {(-1, 0): cx, (1, 0): self.ancho - cx, (0, -1): cy, (0, 1): self.alto - cy}
        dx, dy = min(dist, key=dist.get)
        return vx * dx + vy * dy > 0.05

    def _es_duplicado(self, caja, predicciones, frame_number):
        """La caja se monta sobre un camion que ya se sigue (o esta pegada a uno de la cola):
        es un pedazo o una copia de ese camion, no un camion nuevo."""
        cx, cy = centro_caja(caja)
        for pid, pred in predicciones.items():
            r = self.records[pid]
            if r["state"] == "FUERA" or frame_number - r["last_frame"] > self.frames_confirmar_fuera:
                continue
            if (iou_cajas(caja, pred) > 0.15 or contencion(caja, pred) > 0.35
                    or contencion(pred, caja) > 0.35):
                return True
            if self._anclado(r, frame_number) or self._protegido(r, frame_number):
                px, py = centro_caja(pred)
                if math.hypot(cx - px, cy - py) < 1.0 * max(pred[2], pred[3]):
                    return True
        return False

    def _candidato(self, caja, predicciones, frame_number):
        """Decide si una deteccion sin dueno es un camion nuevo. Devuelve su numero (pid)
        cuando ya se confirmo, o None mientras tanto (no se muestra ni se cuenta)."""
        if self.primer_frame is None:
            self.primer_frame = frame_number
        if self._vivos() >= self.max_camiones or self._es_duplicado(caja, predicciones, frame_number):
            return None
        # Al empezar el video, los camiones que ya estan se aceptan de inmediato.
        if frame_number - self.primer_frame <= 1:
            return self._nuevo()
        cx, cy = centro_caja(caja)
        tam = max(caja[2], caja[3])
        mejor = None
        for t in self.tentativos:
            tx, ty = centro_caja(t["bbox"])
            if frame_number != t["last"] and (iou_cajas(caja, t["bbox"]) > 0.3 or
                                              math.hypot(cx - tx, cy - ty) < 1.5 * tam):
                mejor = t
                break
        if mejor is None:
            self.tentativos.append({"bbox": caja, "first": frame_number, "last": frame_number, "hits": 1})
            return None
        mejor.update(bbox=caja, last=frame_number, hits=mejor["hits"] + 1)
        if mejor["hits"] >= 3 and frame_number - mejor["first"] >= self.frames_confirmar_entrada:
            self.tentativos.remove(mejor)
            return self._nuevo()
        return None

    def _vivos(self):
        return sum(1 for r in self.records.values() if r["state"] != "FUERA")

    def _nuevo(self):
        pid = len(self.records) + 1
        self.records[pid] = {"internal_id": None, "bbox": None,
                             "velocity": (0.0, 0.0, 0.0, 0.0), "last_frame": 0,
                             "state": "LOST", "quieto": 0,
                             "perturbado_hasta": -1, "caja_congelada": None}
        return pid

    def _salio_por_borde(self, r):
        """El camion se perdio cortado por el borde de la imagen (estaba saliendo)."""
        if r["bbox"] is None:
            return False
        x, y, w, h = r["bbox"]
        return x <= 2 or y <= 2 or x + w >= self.ancho - 2 or y + h >= self.alto - 2

    @staticmethod
    def _pisa_a_otro(caja, pid, activos):
        """La caja esta encima de OTRO camion que se esta viendo: es de ese camion (o una copia)."""
        for otro, pred in activos.items():
            if otro == pid:
                continue
            if iou_cajas(caja, pred) > 0.3 or contencion(caja, pred) > 0.5 or contencion(pred, caja) > 0.5:
                return True
        return False

    def _no_puede_tomar(self, r, pid, caja, activos):
        """Reglas para un camion PERDIDO (corrige el cambio de numero 6 -> 8):
        (1) no le quita la caja a un camion que se esta viendo, y
        (2) si salio por el borde, solo puede volver a verse junto al borde."""
        if r["state"] == "ACTIVE":
            return False
        if self._pisa_a_otro(caja, pid, activos):
            return True
        return self._salio_por_borde(r) and not self._en_borde(caja)

    def _protegido(self, r, frame_number):
        return r.get("perturbado_hasta", -1) >= frame_number

    def _confirma_salida(self, pid, caja, predicciones, moviles):
        """Un camion protegido que arranca de verdad produce detecciones de su
        mismo tamano, que se desplazan suavemente (alto IoU entre frames
        seguidos) y que no tocan al camion que pasa. El ruido del cruce, en
        cambio, salta de un frame a otro o se pega al camion en movimiento.
        Devuelve True cuando eso se cumple durante frames_confirmar_salida."""
        r = self.records[pid]
        congelada = r["caja_congelada"]
        toca_movil = any(contencion(caja, predicciones[m]) > 0.05 or
                         contencion(predicciones[m], caja) > 0.05
                         for m in moviles if m != pid)
        _, _, w, h = caja
        _, _, cw, ch = congelada
        tam_ok = (max(w, cw) / max(1, min(w, cw)) <= 1.4 and
                  max(h, ch) / max(1, min(h, ch)) <= 1.4)
        previa = r.get("salida_caja")
        coherente = previa is None or iou_cajas(caja, previa) >= 0.6
        if not toca_movil and tam_ok and coherente:
            r["salida_frames"] = r.get("salida_frames", 0) + 1
            r["salida_caja"] = caja
        else:
            r["salida_frames"] = 0
            r["salida_caja"] = None
        return r["salida_frames"] >= self.frames_confirmar_salida

    def _coste(self, r, caja, internal_id, frame_number):
        if self._protegido(r, frame_number):
            # Solo acepta una deteccion casi identica a su caja congelada,
            # y sin bono de continuidad (ByteTrack tambien puede confundirse).
            congelada = r["caja_congelada"]
            cx, cy = centro_caja(caja)
            px, py = centro_caja(congelada)
            iou = iou_cajas(caja, congelada)
            if math.hypot(cx - px, cy - py) > self.radio_anclado or iou < self.iou_min_protegido:
                return self.COSTE_INVALIDO
            return 1 - iou
        predicha = self._prediccion(r, frame_number)
        cx, cy = centro_caja(caja)
        px, py = centro_caja(predicha)
        distancia = math.hypot(cx - px, cy - py)
        if distancia > self._gate(r, frame_number):
            return self.COSTE_INVALIDO
        _, _, w, h = caja
        _, _, pw, ph = predicha
        pw, ph = max(1, pw), max(1, ph)
        if max(w, pw) / max(1, min(w, pw)) > self.size_ratio or \
           max(h, ph) / max(1, min(h, ph)) > self.size_ratio:
            return self.COSTE_INVALIDO
        coste = (distancia / self.distancia_base
                 + 0.25 * abs(math.log(max(1, w * h) / (pw * ph)))
                 + 0.5 * (1 - iou_cajas(caja, predicha)))
        if r["internal_id"] == internal_id:
            coste -= self.bono_continuidad
        return coste

    # ---------- actualizacion ----------
    def actualizar(self, observaciones, frame_number):
        """observaciones: [(internal_id, (x, y, w, h))].
        Devuelve [(persistent_id, caja, internal_id)] incluyendo camiones
        ocultos dentro de una caja fusionada (con su posicion predicha)."""
        conocidos = {pid: r for pid, r in self.records.items()
                     if r["bbox"] is not None and r["state"] != "FUERA"}
        predicciones = {pid: self._prediccion(r, frame_number) for pid, r in conocidos.items()}

        # 0) Proteger camiones en cola cuando un camion en movimiento pasa cerca.
        #    Se consideran "moviles" los no anclados vistos hace poco (aunque
        #    YOLO los haya perdido un momento por la deformacion del cruce).
        moviles = [pid for pid, r in conocidos.items()
                   if not self._anclado(r, frame_number)
                   and frame_number - r["last_frame"] <= self.frames_post_perturbacion]
        for pid, r in conocidos.items():
            if not self._anclado(r, frame_number):
                continue
            entorno = expandir_caja(r["bbox"], self.margen_perturbacion)
            if any(cajas_se_tocan(predicciones[m], entorno) for m in moviles if m != pid):
                if not self._protegido(r, frame_number):
                    r["caja_congelada"] = r["bbox"]
                r["perturbado_hasta"] = frame_number + self.frames_post_perturbacion
        # La proteccion se contagia a toda la cola: un camion anclado pegado a
        # uno protegido tambien se protege (YOLO deforma a los vecinos tambien).
        cambio = True
        while cambio:
            cambio = False
            protegidos_ahora = [p for p, r in conocidos.items() if self._protegido(r, frame_number)]
            for pid, r in conocidos.items():
                if self._protegido(r, frame_number) or not self._anclado(r, frame_number):
                    continue
                entorno = expandir_caja(r["bbox"], self.margen_perturbacion)
                vecino = next((p for p in protegidos_ahora
                               if cajas_se_tocan(self.records[p]["caja_congelada"], entorno)), None)
                if vecino is not None:
                    r["caja_congelada"] = r["bbox"]
                    r["perturbado_hasta"] = self.records[vecino]["perturbado_hasta"]
                    cambio = True
        protegidos = {pid for pid, r in conocidos.items() if self._protegido(r, frame_number)}
        for pid in protegidos:
            predicciones[pid] = self.records[pid]["caja_congelada"]

        # 1) Detectar cajas fusionadas (una deteccion que contiene a 2+ camiones).
        ocultos = set()
        detecciones_fusionadas = set()
        for i, (_, caja) in enumerate(observaciones):
            dentro = [pid for pid, r in conocidos.items()
                      if r["state"] == "ACTIVE"
                      and contencion(predicciones[pid], caja) >= self.contencion_fusion]
            if len(dentro) >= 2:
                detecciones_fusionadas.add(i)
                ocultos.update(dentro)

        obs_validas = [i for i in range(len(observaciones)) if i not in detecciones_fusionadas]
        # Camiones que se estan viendo (para que uno perdido no les quite su caja).
        activos = {pid: predicciones[pid] for pid, r in conocidos.items() if r["state"] == "ACTIVE"}
        candidatos = [pid for pid in conocidos if pid not in ocultos]
        asignaciones = {}

        # 2) Asignacion global optima.
        if obs_validas and candidatos:
            matriz = np.full((len(obs_validas), len(candidatos)), self.COSTE_INVALIDO)
            for a, i in enumerate(obs_validas):
                internal_id, caja = observaciones[i]
                for b, pid in enumerate(candidatos):
                    if self._no_puede_tomar(conocidos[pid], pid, caja, activos):
                        continue
                    matriz[a, b] = self._coste(conocidos[pid], caja, internal_id, frame_number)
            filas, cols = linear_sum_assignment(matriz)
            for a, b in zip(filas, cols):
                if matriz[a, b] < self.COSTE_INVALIDO:
                    asignaciones[obs_validas[a]] = candidatos[b]

        # 3) Detecciones sueltas: camion nuevo (si faltan) o reasignacion optima
        #    a camiones perdidos. Los protegidos nunca se reasignan.
        usados = set(asignaciones.values()) | ocultos | protegidos
        sueltas = []
        con_candidata = set()
        for i in obs_validas:
            if i in asignaciones:
                continue
            _, caja = observaciones[i]
            # Una deteccion encima de un camion protegido es ruido del cruce:
            # no crea un camion nuevo ni se entrega a otro ID...
            cubiertos = [p for p in protegidos
                         if contencion(caja, self.records[p]["caja_congelada"]) >= 0.3
                         or contencion(self.records[p]["caja_congelada"], caja) >= 0.3]
            # ...salvo que sea un camion protegido saliendo de verdad de la cola.
            cx, cy = centro_caja(caja)
            cercano, dist_cercano = None, 3 * self.radio_anclado
            for p in protegidos:
                px, py = centro_caja(self.records[p]["caja_congelada"])
                dist = math.hypot(cx - px, cy - py)
                if dist <= dist_cercano:
                    cercano, dist_cercano = p, dist
            if cercano is not None and cercano not in con_candidata:
                con_candidata.add(cercano)
                if self._confirma_salida(cercano, caja, predicciones, moviles):
                    self.records[cercano].update(perturbado_hasta=-1, quieto=0,
                                                 salida_frames=0, salida_caja=None)
                    protegidos.discard(cercano)
                    asignaciones[i] = cercano
                    continue
            if cubiertos:
                continue
            sueltas.append(i)
        for pid in protegidos - con_candidata:
            self.records[pid].update(salida_frames=0, salida_caja=None)

        # Si entra por el borde es un camion nuevo. Si aparece en medio de la imagen,
        # primero se intenta devolverle el numero a un camion perdido cercano.
        restantes = []
        for i in sueltas:
            if self._en_borde(observaciones[i][1], 0.35):
                pid = self._candidato(observaciones[i][1], predicciones, frame_number)
                if pid is not None:
                    asignaciones[i] = pid
                    usados.add(pid)
            else:
                restantes.append(i)

        elegibles = [pid for pid, r in self.records.items()
                     if pid not in usados and r["bbox"] is not None and r["state"] != "FUERA"
                     and frame_number - r["last_frame"] >= self.frames_antes_de_forzar]
        # Cajas ya entregadas en este cuadro: una caja encima de ellas es una copia, no otro camion.
        entregadas = {pid: observaciones[i][1] for i, pid in asignaciones.items()}
        entregadas.update({pid: predicciones[pid] for pid in ocultos | protegidos if pid in predicciones})
        if restantes and elegibles:
            matriz = np.full((len(restantes), len(elegibles)), self.COSTE_INVALIDO)
            for a, i in enumerate(restantes):
                if self._pisa_a_otro(observaciones[i][1], None, entregadas):
                    continue                          # copia de un camion ya seguido: no es nadie
                cx, cy = centro_caja(observaciones[i][1])
                for b, pid in enumerate(elegibles):
                    r = self.records[pid]
                    lx, ly = centro_caja(r["bbox"])
                    d = math.hypot(cx - lx, cy - ly)
                    # Un camion anclado en la cola no se entrega a una deteccion lejana.
                    if self._anclado(r, frame_number) and d > self.radio_anclado * 3:
                        continue
                    if d > self.distancia_max:          # demasiado lejos: es otro camion
                        continue
                    if self._salio_por_borde(r) and not self._en_borde(observaciones[i][1]):
                        continue                      # salio por el borde: solo vuelve por el borde
                    matriz[a, b] = d
            filas, cols = linear_sum_assignment(matriz)
            for a, b in zip(filas, cols):
                if matriz[a, b] < self.COSTE_INVALIDO:
                    asignaciones[restantes[a]] = elegibles[b]
                    usados.add(elegibles[b])
        # Lo que no se pudo devolver a nadie es un camion nuevo.
        for i in restantes:
            if i not in asignaciones:
                pid = self._candidato(observaciones[i][1], predicciones, frame_number)
                if pid is not None:
                    asignaciones[i] = pid
                    usados.add(pid)
        # Los posibles camiones que dejaron de verse eran ruido: se olvidan sin numero.
        self.tentativos = [t for t in self.tentativos
                           if frame_number - t["last"] <= max(3, self.frames_confirmar_entrada // 2)]

        # 4) Actualizar estados.
        resultado = []
        # Origen de cada caja devuelta: DETECTADO (YOLO), PREDICHO (oculto en
        # una caja fusionada) o PROTEGIDO (congelado en la cola).
        self.estados = {}
        self.internal_to_persistent = {}
        for i, (internal_id, caja) in enumerate(observaciones):
            pid = asignaciones.get(i)
            if pid is None:
                continue
            r = self.records[pid]
            if pid in protegidos:
                # Confirma que sigue ahi, pero su caja, velocidad y ancla no cambian.
                r.update(last_frame=frame_number, internal_id=internal_id,
                         state="ACTIVE", oculto_desde=None)
                self.internal_to_persistent[internal_id] = pid
                resultado.append((pid, r["caja_congelada"], internal_id))
                self.estados[pid] = "PROTEGIDO"
                continue
            if r["bbox"] is not None:
                dt = max(1, frame_number - r["last_frame"])
                nueva = tuple((a - b) / dt for a, b in zip(caja, r["bbox"]))
                if r["state"] == "LOST":
                    r["velocity"] = nueva
                else:
                    s = self.suavizado_velocidad
                    r["velocity"] = tuple(s * v + (1 - s) * n for v, n in zip(r["velocity"], nueva))
                if math.hypot(r["velocity"][0], r["velocity"][1]) < self.velocidad_quieto:
                    r["quieto"] += dt
                else:
                    r["quieto"] = 0
            r.update(bbox=caja, last_frame=frame_number, internal_id=internal_id,
                     state="ACTIVE", oculto_desde=None)
            self.internal_to_persistent[internal_id] = pid
            resultado.append((pid, caja, internal_id))
            self.estados[pid] = "DETECTADO"

        # Camiones ocultos en una caja fusionada: siguen ACTIVOS con su prediccion.
        for pid in ocultos:
            if pid in protegidos:
                continue  # se agregan abajo con su caja congelada
            r = self.records[pid]
            if r.get("oculto_desde") is None:
                r["oculto_desde"] = frame_number
            if frame_number - r["oculto_desde"] > self.max_frames_oculto:
                r["state"] = "LOST"
                continue
            predicha = tuple(int(v) for v in predicciones[pid])
            resultado.append((pid, predicha, None))
            self.estados[pid] = "PREDICHO"

        # Camiones protegidos sin deteccion valida: siguen ACTIVOS en su sitio.
        ya_incluidos = {pid for pid, _, _ in resultado}
        for pid in protegidos:
            if pid in ya_incluidos:
                continue
            r = self.records[pid]
            r["state"] = "ACTIVE"
            resultado.append((pid, tuple(int(v) for v in r["caja_congelada"]), None))
            self.estados[pid] = "PROTEGIDO"

        for pid, r in self.records.items():
            if pid not in usados and r["state"] == "ACTIVE":
                r["state"] = "LOST"
                r["oculto_desde"] = None
                r["salida_velocidad"] = r["velocity"]     # para saber si iba hacia el borde
                r["velocity"] = tuple(v * 0.5 for v in r["velocity"])

        # 5) Salidas de la imagen: perdido junto al borde, yendo hacia afuera, durante un rato.
        for pid, r in self.records.items():
            if r["state"] != "LOST" or r["bbox"] is None:
                continue
            perdido = frame_number - r["last_frame"]
            if perdido >= self.frames_confirmar_fuera:
                original = r["velocity"]
                r["velocity"] = r.get("salida_velocidad", original)
                sale = self._saliendo(r, frame_number)
                r["velocity"] = original
                if sale:
                    r["state"] = "FUERA"
                    self.salidas.append((pid, r["last_frame"]))
                    continue
            if perdido >= self.frames_olvidar and not self._anclado(r, frame_number):
                r["state"] = "FUERA"                     # perdido hace mucho: se cierra

        return resultado


class RegistroDatos:
    """Acumula los datos de los camiones durante el video y al final los
    exporta a un Excel con varias hojas:
      - Trayectorias: posicion de cada camion cada INTERVALO_MUESTREO_S.
      - Eventos: entradas y salidas de cada zona, con tiempo de permanencia.
      - Resumen_camiones: tiempos, distancia, pasadas y ciclos por camion.
      - Resumen_zonas: entradas, permanencias, ocupacion y camiones por hora.
      - Ocupacion_minuto: camiones dentro de cada zona minuto a minuto.
      - Parametros: datos del video y de la configuracion usada.
    Coordenadas en pixeles de la resolucion original del video."""

    LIMITE_FILAS_EXCEL = 1_000_000

    def __init__(self, video_path, fps, skip_frames, zonas, tipos_zonas,
                 escala_x, escala_y, resolucion_original):
        self.video_path = video_path
        self.fps = fps
        self.skip_frames = max(1, skip_frames)
        self.zonas = zonas
        self.tipos_zonas = tipos_zonas
        self.nombres_zonas = None      # nombres puestos por el usuario (opcional, desde la app)
        self.alertas = None            # notificaciones de la app (curvas, retrocesos...), opcional
        self.georef = None             # Georreferencia (pixeles -> Este/Norte en metros), opcional
        self.estadisticas_vel = None   # pid -> {"vel_max", "t_exceso", "excesos"} (desde la app)
        self.limites_velocidad = None  # funcion -> [(texto, valor)] con los limites usados (desde la app)
        self.escala_x = escala_x
        self.escala_y = escala_y
        self.resolucion_original = resolucion_original
        self.frames_muestreo = (max(1, int(round(INTERVALO_MUESTREO_S * fps)))
                                if INTERVALO_MUESTREO_S > 0 else 1)
        self.ultimo_muestreo = None
        self.ultimo_frame = 0
        self.trayectorias = []
        self.eventos = []
        self.ocupacion = []
        self.camiones = {}
        self.entrada_abierta = {}
        self.entradas = defaultdict(list)
        self.permanencias = defaultdict(list)

    def _caja_original(self, caja):
        x, y, w, h = caja
        return (x * self.escala_x, y * self.escala_y, w * self.escala_x, h * self.escala_y)

    def _metricas(self, pid):
        if pid not in self.camiones:
            self.camiones[pid] = {
                "primera_vez": None, "ultima_vez": None, "ultimo_frame": None,
                "t_visible": 0.0, "t_detenido": 0.0, "t_movimiento": 0.0,
                "distancia": 0.0, "ultimo_centro": None, "ultimo_t_centro": None, "segmentos": [],
                "muestras_detectado": 0, "muestras_estimado": 0,
            }
        return self.camiones[pid]

    def registrar(self, frame_n, tracks, estados, records, estado_zona):
        """Llamar en cada frame con inferencia. tracks: [(id, caja_visual)]."""
        t = frame_n / self.fps
        muestrear = (self.ultimo_muestreo is None or
                     frame_n - self.ultimo_muestreo >= self.frames_muestreo)
        for pid, caja in tracks:
            x, y, w, h = self._caja_original(caja)
            cx, cy = x + w / 2, y + h / 2
            estado = estados.get(pid, "DETECTADO")
            vx, vy = records.get(pid, {}).get("velocity", (0.0, 0.0, 0.0, 0.0))[:2]
            velocidad = 0.0 if estado == "PROTEGIDO" else \
                math.hypot(vx * self.escala_x, vy * self.escala_y) * self.fps
            movimiento = "EN_MOVIMIENTO" if velocidad >= UMBRAL_MOVIMIENTO_PX_S else "DETENIDO"

            m = self._metricas(pid)
            dt = 0.0 if m["ultimo_frame"] is None else \
                min(frame_n - m["ultimo_frame"], self.skip_frames) / self.fps
            m["ultimo_frame"] = frame_n
            if m["primera_vez"] is None:
                m["primera_vez"] = t
            m["ultima_vez"] = t
            m["t_visible"] += dt
            m["t_movimiento" if movimiento == "EN_MOVIMIENTO" else "t_detenido"] += dt

            # La distancia solo suma con detecciones reales y en movimiento
            # (asi el temblor de la caja de un camion quieto no cuenta).
            # Se mide entre puntos separados al menos 0.2 s para no sumar el
            # zigzag del temblor de la caja entre frames consecutivos.
            if estado == "DETECTADO":
                if m["ultimo_centro"] is None:
                    m["ultimo_centro"], m["ultimo_t_centro"] = (cx, cy), t
                elif t - m["ultimo_t_centro"] >= 0.2:
                    if movimiento == "EN_MOVIMIENTO":
                        d = math.hypot(cx - m["ultimo_centro"][0], cy - m["ultimo_centro"][1])
                        if d / (t - m["ultimo_t_centro"]) <= VELOCIDAD_MAX_PX_S:
                            m["distancia"] += d
                            # Se guarda el tramo para medirlo en metros al exportar
                            # (la georreferencia se puede definir despues del analisis).
                            m["segmentos"].append((*m["ultimo_centro"], cx, cy))
                    m["ultimo_centro"], m["ultimo_t_centro"] = (cx, cy), t

            if muestrear:
                m["muestras_detectado" if estado == "DETECTADO" else "muestras_estimado"] += 1
                zonas_dentro = [f"Z{z + 1}" for z in range(len(self.zonas))
                                if estado_zona.get((pid, z)) == "dentro"]
                self.trayectorias.append({
                    "tiempo_s": round(t, 2),
                    "tiempo_hms": str(timedelta(seconds=int(t))),
                    "frame": frame_n,
                    "id_camion": pid,
                    "centro_x": round(cx, 1),
                    "centro_y": round(cy, 1),
                    "caja_x": round(x, 1),
                    "caja_y": round(y, 1),
                    "caja_ancho": round(w, 1),
                    "caja_alto": round(h, 1),
                    "velocidad_px_s": round(velocidad, 1),
                    "movimiento": movimiento,
                    "zona_actual": ", ".join(zonas_dentro) if zonas_dentro else "-",
                    "estado": estado,
                })

        if muestrear:
            self.ultimo_muestreo = frame_n
            ids_presentes = [pid for pid, _ in tracks]
            for z in range(len(self.zonas)):
                n = sum(1 for pid in ids_presentes if estado_zona.get((pid, z)) == "dentro")
                self.ocupacion.append({"tiempo_s": t, "zona": f"Z{z + 1}", "camiones": n})
        self.ultimo_frame = frame_n

    def evento(self, frame_n, pid, zona_id, tipo, contado=True):
        """tipo: 'ENTRADA' o 'SALIDA'."""
        t = frame_n / self.fps
        clave = (pid, zona_id)
        duracion = None
        if tipo == "ENTRADA":
            self.entrada_abierta[clave] = t
            self.entradas[clave].append((t, contado))
        else:
            t0 = self.entrada_abierta.pop(clave, None)
            if t0 is not None:
                duracion = t - t0
                self.permanencias[clave].append(duracion)
        self.eventos.append({
            "tiempo_s": round(t, 2),
            "tiempo_hms": str(timedelta(seconds=int(t))),
            "frame": frame_n,
            "id_camion": pid,
            "zona": f"Z{zona_id + 1}",
            "tipo_zona": self.tipos_zonas[zona_id].upper(),
            "zona_id_interno": zona_id,
            "evento": tipo,
            "permanencia_s": round(duracion, 2) if duracion is not None else None,
            "contado_en_panel": "SI" if (tipo == "ENTRADA" and contado) else
                                ("NO" if tipo == "ENTRADA" else "-"),
        })

    def _nombre_zona(self, z):
        nombres = self.nombres_zonas or []
        nombre = nombres[z].strip() if z < len(nombres) and nombres[z] else ""
        return nombre or f"Zona {z + 1}"

    # ---------- exportacion ----------
    def _permanencias_con_abiertas(self):
        """Permanencias cerradas + las que siguen abiertas al final del video
        (por ejemplo, camiones que pasaron todo el video en la cola)."""
        t_final = self.ultimo_frame / self.fps
        perm = defaultdict(list)
        for clave, lista in self.permanencias.items():
            perm[clave].extend(lista)
        for clave, t0 in self.entrada_abierta.items():
            perm[clave].append(t_final - t0)
        return perm

    def _eventos_finales(self):
        t_final = self.ultimo_frame / self.fps
        filas = []
        for e in self.eventos:
            fila = dict(e)
            fila["nombre_zona"] = self._nombre_zona(e["zona_id_interno"])
            filas.append(fila)
        for (pid, z), t0 in sorted(self.entrada_abierta.items()):
            filas.append({
                "tiempo_s": round(t_final, 2),
                "tiempo_hms": str(timedelta(seconds=int(t_final))),
                "frame": self.ultimo_frame,
                "id_camion": pid,
                "zona": f"Z{z + 1}",
                "nombre_zona": self._nombre_zona(z),
                "tipo_zona": self.tipos_zonas[z].upper(),
                "evento": "SIGUE_DENTRO_AL_FINAL",
                "permanencia_s": round(t_final - t0, 2),
                "contado_en_panel": "-",
            })
        return filas

    def _distancia_metros(self, m):
        """Distancia recorrida y velocidad media en metros (solo si hay georreferencia)."""
        if self.georef is None:
            return {}
        total = 0.0
        for x1, y1, x2, y2 in m["segmentos"]:
            e1, n1 = self.georef.a_coordenadas(x1, y1)
            e2, n2 = self.georef.a_coordenadas(x2, y2)
            total += math.hypot(e2 - e1, n2 - n1)
        vel = total / m["t_movimiento"] * 3.6 if m["t_movimiento"] > 0 else 0.0
        return {"distancia_m": round(total, 1), "velocidad_media_en_movimiento_km_h": round(vel, 1)}

    def _velocidad_extra(self, pid):
        est = (self.estadisticas_vel or {}).get(pid)
        if self.georef is None or est is None:
            return {}
        return {"velocidad_maxima_km_h": round(est["vel_max"], 1),
                "veces_sobre_el_limite": est["excesos"],
                "tiempo_sobre_el_limite_s": round(est["t_exceso"], 1)}

    def _trayectorias_georef(self):
        """Agrega Este, Norte (m) y velocidad (km/h) a cada fila de la trayectoria."""
        if self.georef is None:
            return self.trayectorias
        filas, ultimo = [], {}
        for fila in self.trayectorias:
            fila = dict(fila)
            e, n = self.georef.a_coordenadas(fila["centro_x"], fila["centro_y"])
            if self.georef.es_plano():
                # Plano local: X, Y en metros desde la esquina inferior izquierda del video.
                e0, n0 = self.georef.origen_plano()
                fila["x_m"], fila["y_m"] = round(e - e0, 2), round(n - n0, 2)
                if e0 or n0:
                    fila["este_m"], fila["norte_m"] = round(e, 2), round(n, 2)
            else:
                fila["este_m"], fila["norte_m"] = round(e, 2), round(n, 2)
            previo = ultimo.get(fila["id_camion"])
            vel = 0.0
            if previo is not None and fila["movimiento"] == "EN_MOVIMIENTO":
                dt = fila["tiempo_s"] - previo[0]
                if dt > 0:
                    vel = math.hypot(e - previo[1], n - previo[2]) / dt * 3.6
            fila["velocidad_km_h"] = round(vel, 1)
            ultimo[fila["id_camion"]] = (fila["tiempo_s"], e, n)
            filas.append(fila)
        return filas

    def _resumen_camiones(self):
        permanencias = self._permanencias_con_abiertas()
        filas = []
        for pid in sorted(self.camiones):
            m = self.camiones[pid]
            total = m["muestras_detectado"] + m["muestras_estimado"]
            fila = {
                "id_camion": pid,
                "primera_aparicion_s": round(m["primera_vez"], 2),
                "ultima_aparicion_s": round(m["ultima_vez"], 2),
                "tiempo_visible_s": round(m["t_visible"], 2),
                "tiempo_detenido_s": round(m["t_detenido"], 2),
                "tiempo_en_movimiento_s": round(m["t_movimiento"], 2),
                "porcentaje_detenido": round(100 * m["t_detenido"] / m["t_visible"], 1)
                if m["t_visible"] > 0 else 0.0,
                "distancia_px": round(m["distancia"], 1),
                **self._distancia_metros(m),
                **self._velocidad_extra(pid),
                "velocidad_media_en_movimiento_px_s": round(m["distancia"] / m["t_movimiento"], 1)
                if m["t_movimiento"] > 0 else 0.0,
                "porcentaje_posiciones_estimadas": round(100 * m["muestras_estimado"] / total, 1)
                if total else 0.0,
            }
            for z in range(len(self.zonas)):
                entradas = [t for t, _ in self.entradas.get((pid, z), [])]
                perm = permanencias.get((pid, z), [])
                ciclos = [b - a for a, b in zip(entradas, entradas[1:])]
                fila[f"entradas_Z{z + 1}"] = len(entradas)
                fila[f"tiempo_total_en_Z{z + 1}_s"] = round(sum(perm), 2)
                fila[f"permanencia_prom_Z{z + 1}_s"] = round(sum(perm) / len(perm), 2) if perm else None
                fila[f"ciclo_prom_Z{z + 1}_s"] = round(sum(ciclos) / len(ciclos), 2) if ciclos else None
            filas.append(fila)
        return filas

    def _resumen_zonas(self):
        duracion_h = max(1e-9, self.ultimo_frame / self.fps / 3600)
        permanencias = self._permanencias_con_abiertas()
        filas = []
        for z, zona in enumerate(self.zonas):
            entradas = [e for (pid, zz), lista in self.entradas.items() if zz == z for e in lista]
            contadas = sum(1 for _, contado in entradas if contado)
            perm = [p for (pid, zz), lista in permanencias.items() if zz == z for p in lista]
            ocup = [o["camiones"] for o in self.ocupacion if o["zona"] == f"Z{z + 1}"]
            x, y, w, h = self._caja_original(zona)
            filas.append({
                "zona": f"Z{z + 1}",
                "nombre_zona": self._nombre_zona(z),
                "tipo": self.tipos_zonas[z].upper(),
                "entradas_totales": len(entradas),
                "pasadas_contadas_en_panel": contadas,
                "camiones_por_hora": round(contadas / duracion_h, 1),
                "permanencia_prom_s": round(sum(perm) / len(perm), 2) if perm else None,
                "permanencia_min_s": round(min(perm), 2) if perm else None,
                "permanencia_max_s": round(max(perm), 2) if perm else None,
                "ocupacion_promedio": round(sum(ocup) / len(ocup), 2) if ocup else None,
                "ocupacion_maxima": max(ocup) if ocup else None,
                "zona_x": round(x), "zona_y": round(y),
                "zona_ancho": round(w), "zona_alto": round(h),
            })
        return filas

    def _ocupacion_por_minuto(self, pd):
        if not self.ocupacion:
            return pd.DataFrame()
        df = pd.DataFrame(self.ocupacion)
        df["minuto"] = (df["tiempo_s"] // 60).astype(int)
        tabla = df.groupby(["minuto", "zona"])["camiones"].agg(["mean", "max"]).unstack("zona")
        tabla.columns = [f"{zona}_{'promedio' if est == 'mean' else 'maximo'}"
                         for est, zona in tabla.columns]
        tabla = tabla[sorted(tabla.columns,
                             key=lambda c: (int(c.split("_")[0][1:]), c.endswith("maximo")))]
        tabla = tabla.round(2).reset_index()
        tabla.insert(1, "desde", tabla["minuto"].apply(lambda mi: str(timedelta(minutes=int(mi)))))
        return tabla

    def _parametros(self):
        ancho, alto = self.resolucion_original
        return [
            ("Fecha de exportacion", datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
            ("Video", self.video_path),
            ("Duracion procesada", str(timedelta(seconds=int(self.ultimo_frame / self.fps)))),
            ("FPS del video", round(self.fps, 2)),
            ("Frames procesados", self.ultimo_frame),
            ("Resolucion original (px)", f"{ancho} x {alto}"),
            ("Unidades de posicion", "pixeles de la resolucion original (origen arriba a la izquierda)"
             + ("; ademas metros segun la calibracion (ver filas 'Georreferencia')"
                if self.georef is not None else "")),
            ("Intervalo de muestreo de trayectorias (s)", INTERVALO_MUESTREO_S),
            ("Umbral de movimiento (px/s)", UMBRAL_MOVIMIENTO_PX_S),
            # Mismos valores que motor.py (UMBRAL_ENTRADA_ZONA y UMBRAL_SALIDA_ZONA).
            ("Umbral de entrada a zona", "90% del camion dentro (forma real del camion)"),
            ("Umbral de salida de zona", "10% del camion dentro o menos"),
            ("Estado DETECTADO", "posicion medida por YOLO"),
            ("Estado PREDICHO", "camion oculto en una caja fusionada; posicion estimada"),
            ("Estado PROTEGIDO", "camion en cola congelado mientras otro pasa cerca"),
            ("Evento SIGUE_DENTRO_AL_FINAL",
             "el camion seguia en la zona al terminar; su permanencia se cuenta hasta el final"),
        ] + ([("Georreferencia", "definida por el usuario (coordenadas de libre eleccion)")]
             + [(f"Georreferencia - {k}", v) for k, v in self.georef.descripcion()]
             if self.georef is not None else [("Georreferencia", "no definida (solo pixeles)")]) \
            + (self.limites_velocidad() if self.limites_velocidad else [])

    @staticmethod
    def _formatear_hoja(hoja):
        from openpyxl.styles import Alignment, Font, PatternFill
        from openpyxl.utils import get_column_letter
        relleno = PatternFill("solid", start_color="1F3864")
        for celda in hoja[1]:
            celda.font = Font(bold=True, color="FFFFFF")
            celda.fill = relleno
            celda.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        hoja.row_dimensions[1].height = 32
        hoja.freeze_panes = "A2"
        for col in hoja.columns:
            letra = get_column_letter(col[0].column)
            largo = max(len(str(c.value)) if c.value is not None else 0 for c in col[:200])
            hoja.column_dimensions[letra].width = min(max(10, largo + 2), 60)
        if hoja.max_row > 1:
            hoja.auto_filter.ref = hoja.dimensions

    def _limite_general(self):
        if not self.limites_velocidad:
            return None
        for texto, valor in self.limites_velocidad():
            if "general" in str(texto).lower() and isinstance(valor, (int, float)):
                return valor
        return None

    def _datos_reporte(self, trayectorias, posiciones=True):
        """Todo lo que necesita reporte_excel, en un diccionario simple."""
        return {
            "video": os.path.basename(str(self.video_path)) if self.video_path else "-",
            "duracion_s": self.ultimo_frame / self.fps if self.fps else 0.0,
            "fps": self.fps,
            "resolucion": tuple(self.resolucion_original),
            "georef": self.georef,
            "camiones": self._resumen_camiones(),
            "zonas": self._resumen_zonas(),
            "eventos": self._eventos_finales(),
            "alertas": list(self.alertas or []),
            "trayectorias": trayectorias if posiciones else [],
            "trayectorias_calculo": trayectorias,
            "ocupacion": list(self.ocupacion),
            "nombres_zonas": [self._nombre_zona(z) for z in range(len(self.zonas))],
            "tipos_zonas": list(self.tipos_zonas),
            "intervalo": INTERVALO_MUESTREO_S,
            "limite_general": self._limite_general(),
        }

    def exportar(self, carpeta):
        try:
            import pandas as pd
            import openpyxl  # noqa: F401
        except ImportError as error:
            import sys
            print(f"No se pudo exportar a Excel: falta la libreria '{error.name}'.")
            print("Instalala en ESTE Python (el que ejecuta el programa) con:")
            print(f'    "{sys.executable}" -m pip install pandas openpyxl')
            return None
        os.makedirs(carpeta, exist_ok=True)
        marca = datetime.now().strftime("%Y%m%d_%H%M%S")
        ruta_excel = os.path.join(carpeta, f"camiones_{marca}.xlsx")

        df_tray = pd.DataFrame(self._trayectorias_georef())
        ruta_csv = None
        if len(df_tray) > self.LIMITE_FILAS_EXCEL:
            # Excel no admite tantas filas: la trayectoria completa va a un CSV.
            ruta_csv = os.path.join(carpeta, f"trayectorias_{marca}.csv")
            df_tray.to_csv(ruta_csv, index=False, encoding="utf-8-sig")
            df_tray = pd.DataFrame({"aviso": [
                f"Hay {len(self.trayectorias)} filas, mas de las que admite Excel. "
                f"La trayectoria completa esta en {os.path.basename(ruta_csv)}. "
                f"Sube INTERVALO_MUESTREO_S para que entre en esta hoja."]})

        # Reporte profesional (portada, graficos, detenciones...). Si algo falla, se usa el
        # formato simple de siempre para no perder los datos.
        try:
            import reporte_excel
            tray = self._trayectorias_georef()
            reporte_excel.generar(self._datos_reporte(tray, posiciones=ruta_csv is None), ruta_excel,
                                  self._parametros(),
                                  aviso_posiciones=(f"Hay demasiadas filas para Excel: las posiciones completas "
                                                    f"están en {os.path.basename(ruta_csv)}." if ruta_csv else None))
            print(f"Datos exportados a: {ruta_excel}")
            if ruta_csv:
                print(f"Trayectoria completa en: {ruta_csv}")
            return ruta_excel
        except Exception as error:
            import traceback
            traceback.print_exc()
            print(f"Aviso: no se pudo crear el reporte con graficos ({error}); se exporta el formato simple.")

        hojas = {
            "Resumen_camiones": pd.DataFrame(self._resumen_camiones()),
            "Resumen_zonas": pd.DataFrame(self._resumen_zonas()),
            "Eventos": pd.DataFrame(self._eventos_finales(), columns=[
                "tiempo_s", "tiempo_hms", "frame", "id_camion", "zona", "nombre_zona", "tipo_zona",
                "evento", "permanencia_s", "contado_en_panel"]),
            "Avisos": pd.DataFrame([dict(a, tiempo_hms=str(timedelta(seconds=int(a["tiempo_s"]))))
                                    for a in (self.alertas or [])],
                                   columns=["tiempo_s", "tiempo_hms", "nivel", "tipo", "id_camion",
                                            "zona", "titulo", "detalle"]),
            "Trayectorias": df_tray,
            "Ocupacion_minuto": self._ocupacion_por_minuto(pd),
            "Parametros": pd.DataFrame(self._parametros(), columns=["parametro", "valor"]),
        }
        with pd.ExcelWriter(ruta_excel, engine="openpyxl") as escritor:
            for nombre, df in hojas.items():
                if df.empty:
                    df = pd.DataFrame({"aviso": ["Sin datos registrados"]})
                df.to_excel(escritor, sheet_name=nombre, index=False)
                self._formatear_hoja(escritor.sheets[nombre])

        print(f"Datos exportados a: {ruta_excel}")
        if ruta_csv:
            print(f"Trayectoria completa en: {ruta_csv}")
        return ruta_excel


ITEMS_LEYENDA = [("acumulativa", "ACUMULATIVA (PASADAS)"), ("dinamica", "DINAMICA (OCUPACION)")]
FUENTE_LEYENDA = (cv2.FONT_HERSHEY_SIMPLEX, 0.32, 1) if hasattr(cv2, "FONT_HERSHEY_SIMPLEX") else None


def medir_leyenda():
    """Ancho y alto de la leyenda horizontal en pixeles."""
    fuente, escala, grosor = FUENTE_LEYENDA
    ancho = 6
    alto_texto = 0
    for _, texto in ITEMS_LEYENDA:
        (tw, th), base = cv2.getTextSize(texto, fuente, escala, grosor)
        ancho += 8 + 5 + tw + 10           # circulo + espacio + texto + separacion
        alto_texto = max(alto_texto, th + base)
    return ancho - 10 + 6, alto_texto + 6


def dibujar_leyenda(frame, rect, colores):
    """Dibuja la leyenda en rect=(x1, y1, x2, y2) con fondo semitransparente."""
    x1, y1, x2, y2 = rect
    fuente, escala, grosor = FUENTE_LEYENDA
    roi = frame[y1:y2, x1:x2]
    if roi.size == 0:
        return
    fondo = np.full_like(roi, (25, 25, 25))
    cv2.addWeighted(fondo, OPACIDAD_LEYENDA, roi, 1 - OPACIDAD_LEYENDA, 0, dst=roi)
    cv2.rectangle(frame, (x1, y1), (x2 - 1, y2 - 1), (70, 70, 70), 1)
    cx = x1 + 6
    cy = (y1 + y2) // 2
    for tipo, texto in ITEMS_LEYENDA:
        (tw, th), _ = cv2.getTextSize(texto, fuente, escala, grosor)
        cv2.circle(frame, (cx + 4, cy), 3, colores[tipo], -1, cv2.LINE_AA)
        cv2.putText(frame, texto, (cx + 13, cy + th // 2), fuente, escala,
                    (235, 235, 235), grosor, cv2.LINE_AA)
        cx += 8 + 5 + tw + 10


def _medidas_panel(tipos_zonas):
    """Distribucion del panel horizontal. Mide con valores de ancho maximo
    ('999', '00:00:00') para que el panel no cambie de tamano mientras corre.
    Si no entra en la imagen, primero reduce la letra y, si hay muchas zonas,
    usa etiquetas cortas ('Z1:' en vez de 'Z1 DENTRO:')."""
    fuente, grosor = cv2.FONT_HERSHEY_SIMPLEX, 1
    ancho_max = ANCHO_VISUAL - 2 * MARGEN_LEYENDA_PX
    for corto, escala_min in ((False, 0.36), (True, 0.30)):
        escala = 0.45
        while True:
            slots = []
            alto_txt = 0
            for z, tipo in enumerate(tipos_zonas):
                if corto:
                    etiqueta = f"Z{z + 1}:"
                else:
                    etiqueta = f"Z{z + 1} {'DENTRO' if tipo == 'dinamica' else 'PASADAS'}:"
                (tw, th), base = cv2.getTextSize(etiqueta, fuente, escala, grosor)
                (vw, _), _ = cv2.getTextSize("999", fuente, escala, 2)
                slots.append((tipo, etiqueta, 14 + tw + 6 + vw))
                alto_txt = max(alto_txt, th + base)
            (tw, th), base = cv2.getTextSize("TIEMPO:", fuente, escala, grosor)
            (vw, _), _ = cv2.getTextSize("00:00:00", fuente, escala, grosor)
            slots.append((None, "TIEMPO:", tw + 6 + vw))
            alto_txt = max(alto_txt, th + base)
            ancho = 8 + sum(sl[2] for sl in slots) + 19 * (len(slots) - 1) + 8
            if ancho <= ancho_max:
                return slots, ancho, alto_txt + 12, (fuente, escala, grosor)
            if escala - 0.03 < escala_min - 1e-9:
                break
            escala -= 0.03
    return slots, ancho, alto_txt + 12, (fuente, escala, grosor)


def medir_panel(tipos_zonas):
    _, ancho, alto, _ = _medidas_panel(tipos_zonas)
    return ancho, alto


def dibujar_panel(frame, rect, tipos_zonas, valores, tiempo, colores):
    """Panel en una linea: ● Z1 DENTRO: 7 | ● Z2 PASADAS: 0 | TIEMPO: 0:01:24"""
    slots, _, _, (fuente, escala, grosor) = _medidas_panel(tipos_zonas)
    x1, y1, x2, y2 = rect
    roi = frame[y1:y2, x1:x2]
    if roi.size == 0:
        return
    fondo = np.full_like(roi, (25, 25, 25))
    cv2.addWeighted(fondo, OPACIDAD_PANEL, roi, 1 - OPACIDAD_PANEL, 0, dst=roi)
    cv2.rectangle(frame, (x1, y1), (x2 - 1, y2 - 1), (70, 70, 70), 1)
    cy = (y1 + y2) // 2
    x = x1 + 8
    for i, (tipo, etiqueta, ancho_slot) in enumerate(slots):
        (tw, th), _ = cv2.getTextSize(etiqueta, fuente, escala, grosor)
        base_y = cy + th // 2
        cx = x
        if tipo is not None:
            cv2.circle(frame, (cx + 4, cy), 4, colores[tipo], -1, cv2.LINE_AA)
            cx += 14
            valor, color_valor, grosor_valor = str(valores[i]), colores[tipo], 2
        else:
            valor, color_valor, grosor_valor = tiempo, (0, 255, 0), 1
        cv2.putText(frame, etiqueta, (cx, base_y), fuente, escala, (235, 235, 235), grosor, cv2.LINE_AA)
        cv2.putText(frame, valor, (cx + tw + 6, base_y), fuente, escala, color_valor,
                    grosor_valor, cv2.LINE_AA)
        x += ancho_slot
        if i < len(slots) - 1:
            cv2.line(frame, (x + 9, y1 + 5), (x + 9, y2 - 6), (90, 90, 90), 1)
            x += 19


class UbicadorElemento:
    """Elige la esquina donde un elemento (panel o leyenda) estorba menos. Para cada esquina
    calcula un costo con:
      - por donde han pasado camiones (mapa de calor que se va olvidando),
      - cuanto tapa de las zonas dibujadas,
      - cuanto detalle de la imagen tapa (bordes de carreteras, bermas...).
    Las esquinas que tocan otro elemento o el texto de rendimiento quedan
    descartadas. Solo cambia de esquina si la nueva es claramente mejor,
    para que el elemento no salte de un lado a otro."""

    ESQUINAS = ("inf_izq", "inf_der", "sup_izq", "sup_der")

    def __init__(self, ancho_img, alto_img, ancho, alto, margen, fps, posicion="auto"):
        self.posicion = posicion
        self.W, self.H = ancho_img, alto_img
        self.w, self.h, self.m = ancho, alto, margen
        self.calor = np.zeros((alto_img, ancho_img), np.float32)
        self.frames_reevaluar = max(1, int(round(SEGUNDOS_REEVALUAR_LEYENDA * fps)))
        self.ultimo = None
        self.actual = None
        self.rect_fijo = None   # posicion dibujada a mano en la ventana de zonas

    def rect(self, esquina):
        x1 = self.m if esquina.endswith("izq") else self.W - self.m - self.w
        y1 = self.m if esquina.startswith("sup") else self.H - self.m - self.h
        return (x1, y1, x1 + self.w, y1 + self.h)

    def registrar_camiones(self, cajas):
        self.calor *= 0.995
        for _, (x, y, w, h) in cajas:
            x1, y1 = max(0, int(x)), max(0, int(y))
            x2, y2 = min(self.W, int(x + w)), min(self.H, int(y + h))
            if x2 > x1 and y2 > y1:
                self.calor[y1:y2, x1:x2] += 1.0

    def _costo(self, rect, bordes, zonas, prohibidos):
        x1, y1, x2, y2 = rect
        if any(rects_se_cruzan(rect, p) for p in prohibidos):
            return float("inf")
        pico = max(1.0, float(self.calor.max()))
        costo_calor = float(self.calor[y1:y2, x1:x2].mean()) / pico
        costo_bordes = float(bordes[y1:y2, x1:x2].mean()) / 255.0
        costo_zonas = sum(contencion((x1, y1, x2 - x1, y2 - y1), z) for z in zonas)
        return 10.0 * costo_calor + 1.0 * costo_bordes + 2.0 * costo_zonas

    def elegir(self, frame_n, frame, zonas, prohibidos):
        if self.rect_fijo is not None:
            return self.rect_fijo
        if self.posicion in self.ESQUINAS:
            return self.rect(self.posicion)
        if (self.actual is not None and frame_n - self.ultimo < self.frames_reevaluar
                and not any(rects_se_cruzan(self.rect(self.actual), p) for p in prohibidos)):
            return self.rect(self.actual)
        self.ultimo = frame_n
        gris = cv2.GaussianBlur(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (5, 5), 0)
        bordes = cv2.dilate(cv2.Canny(gris, 50, 150), np.ones((5, 5), np.uint8))
        costos = {e: self._costo(self.rect(e), bordes, zonas, prohibidos) for e in self.ESQUINAS}
        mejor = min(costos, key=costos.get)
        if self.actual is None or costos[self.actual] == float("inf") \
                or costos[mejor] < 0.7 * costos[self.actual]:
            self.actual = mejor
        return self.rect(self.actual)


def dibujar_camiones(frame, cajas, zonas_ocupadas, poligonos=None):
    """Dibuja todas las cajas (un solo color, linea fina) y luego las
    etiquetas con el ID, buscando para cada etiqueta una posicion que no
    tape a otra etiqueta ni a los rotulos de zona/panel."""
    fuente, escala, grosor = cv2.FONT_HERSHEY_SIMPLEX, ESCALA_TEXTO_ETIQUETA, 1
    alto_img, ancho_img = frame.shape[:2]

    poligonos = poligonos or {}
    for track_id, (x, y, w, h) in cajas:
        if track_id in poligonos:
            # Caja rotada, ubicada en el centro de la caja (suavizada) del camion.
            pts = (poligonos[track_id] + [x + w / 2, y + h / 2]).astype(np.int32)
            cv2.polylines(frame, [pts], True, COLOR_CAJA, GROSOR_CAJA, cv2.LINE_AA)
        else:
            cv2.rectangle(frame, (x, y), (x + w, y + h), COLOR_CAJA, GROSOR_CAJA, cv2.LINE_AA)

    ocupadas = list(zonas_ocupadas)
    # Primero las cajas mas arriba, asi las de abajo se acomodan.
    for track_id, (x, y, w, h) in sorted(cajas, key=lambda item: item[1][1]):
        texto = str(track_id)
        (tw, th), base = cv2.getTextSize(texto, fuente, escala, grosor)
        ew, eh = tw + 6, th + base + 2
        candidatos = [
            (x, y - eh),                 # arriba a la izquierda
            (x + w - ew, y - eh),        # arriba a la derecha
            (x, y + h),                  # abajo a la izquierda
            (x + w - ew, y + h),         # abajo a la derecha
            (x - ew, y),                 # a la izquierda
            (x + w, y),                  # a la derecha
            (x + 1, y + 1),              # dentro, esquina superior
        ]
        elegido = None
        for ex, ey in candidatos:
            ex = min(max(0, ex), ancho_img - ew)
            ey = min(max(0, ey), alto_img - eh)
            rect = (ex, ey, ex + ew, ey + eh)
            if not any(rects_se_cruzan(rect, otro) for otro in ocupadas):
                elegido = rect
                break
        if elegido is None:
            ex = min(max(0, x), ancho_img - ew)
            ey = min(max(0, y - eh), alto_img - eh)
            elegido = (ex, ey, ex + ew, ey + eh)
        ocupadas.append(elegido)
        ex1, ey1, ex2, ey2 = elegido
        cv2.rectangle(frame, (ex1, ey1), (ex2, ey2), COLOR_CAJA, -1)
        cv2.putText(frame, texto, (ex1 + 3, ey2 - base - 1), fuente, escala,
                    COLOR_TEXTO_ETIQUETA, 1, cv2.LINE_AA)


def main():
    dispositivo = elegir_dispositivo()
    cap = cv2.VideoCapture(VIDEO_PATH)
    if not cap.isOpened():
        print(f"Error: no se pudo abrir el archivo de video {VIDEO_PATH}")
        return

    print(f"Cargando modelo YOLO: {MODEL_PATH}")
    model = YOLO(MODEL_PATH)
    configurar_bytetrack()
    color_acumulativa = (0, 128, 255)
    color_dinamica = (255, 0, 255)
    seleccion = {"zonas": [], "tipos": [], "modo": "acumulativa", "dibujando": False,
                 "tam_leyenda": medir_leyenda(), "leyenda_pos": None, "panel_pos": None,
                 "ix": -1, "iy": -1, "fx": -1, "fy": -1}

    frame_diseno = None
    for _ in range(10):
        success, primer_frame = cap.read()
        if success and primer_frame is not None:
            frame_diseno = cv2.resize(primer_frame, (ANCHO_VISUAL, ALTO_VISUAL))
    if frame_diseno is None:
        print("Error critico al leer el video.")
        cap.release()
        return

    ventana_zonas = "DIBUJA TUS ZONAS DE CONTROL"
    cv2.namedWindow(ventana_zonas, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(ventana_zonas, ANCHO_VISUAL, ALTO_VISUAL)
    cv2.setMouseCallback(ventana_zonas, dibujar_zonas, seleccion)
    print("Controles: 'a' acumulativa | 'd' dinamica | 'l' colocar leyenda | 'p' colocar panel | "
          "arrastra | click derecho deshacer | ENTER terminar")
    colores_leyenda = {"acumulativa": color_acumulativa, "dinamica": color_dinamica}
    color_modo_leyenda = (230, 230, 230)
    while True:
        imagen = frame_diseno.copy()
        for i, zona in enumerate(seleccion["zonas"]):
            x, y, w, h = zona
            tipo = seleccion["tipos"][i]
            color = color_dinamica if tipo == "dinamica" else color_acumulativa
            cv2.rectangle(imagen, (x, y), (x + w, y + h), color, 2)
            cv2.putText(imagen, f"ZONA {i + 1} ({'DINAMICA' if tipo == 'dinamica' else 'ACUM.'})",
                        (x, max(18, y - 5)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
        if seleccion["dibujando"] and seleccion["modo"] not in ELEMENTOS_MOVIBLES:
            cv2.rectangle(imagen, (seleccion["ix"], seleccion["iy"]),
                          (seleccion["fx"], seleccion["fy"]), (255, 255, 255), 1)
        # Vista previa del panel y la leyenda donde los hayas colocado.
        if seleccion["panel_pos"] is not None:
            w_p, h_p = medir_panel(seleccion["tipos"])
            dibujar_panel(imagen, rect_elemento(seleccion["panel_pos"], w_p, h_p), seleccion["tipos"],
                          [0] * len(seleccion["tipos"]), "0:00:00", colores_leyenda)
        if seleccion["leyenda_pos"] is not None:
            dibujar_leyenda(imagen, rect_elemento(seleccion["leyenda_pos"], *seleccion["tam_leyenda"]),
                            colores_leyenda)
        modo = seleccion["modo"]
        if modo in ELEMENTOS_MOVIBLES and seleccion[f"{modo}_pos"] is None:
            cv2.putText(imagen, f"Haz clic donde quieras {'la leyenda' if modo == 'leyenda' else 'el panel'}"
                        " (clic derecho = automatica)", (18, 70), cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                        color_modo_leyenda, 1, cv2.LINE_AA)
        if modo in ELEMENTOS_MOVIBLES:
            color_modo = color_modo_leyenda
        else:
            color_modo = color_dinamica if modo == "dinamica" else color_acumulativa
        cv2.rectangle(imagen, (10, 10), (640, 45), (20, 20, 20), -1)
        cv2.rectangle(imagen, (10, 10), (640, 45), color_modo, 2)
        cv2.putText(imagen, f"MODO: {modo.upper()}  ('a' Acum. | 'd' Dinam. | 'l' Leyenda | 'p' Panel)",
                    (18, 33), cv2.FONT_HERSHEY_SIMPLEX, 0.52, color_modo, 2, cv2.LINE_AA)
        cv2.imshow(ventana_zonas, imagen)
        key = cv2.waitKey(1) & 0xFF
        if key == 13:
            break
        if key == ord("a"):
            seleccion["modo"] = "acumulativa"
            print("-> Modo activo: ACUMULATIVA")
        elif key == ord("d"):
            seleccion["modo"] = "dinamica"
            print("-> Modo activo: DINAMICA")
        elif key == ord("l"):
            seleccion["modo"] = "leyenda"
            print("-> Modo activo: LEYENDA (clic o arrastra para colocarla)")
        elif key == ord("p"):
            seleccion["modo"] = "panel"
            print("-> Modo activo: PANEL (clic o arrastra para colocarlo)")
    cv2.destroyWindow(ventana_zonas)
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

    zonas = seleccion["zonas"]
    tipos_zonas = seleccion["tipos"]
    totales_por_zona = {i: 0 for i in range(len(zonas))}
    ocupacion_actual = {i: 0 for i, tipo in enumerate(tipos_zonas) if tipo == "dinamica"}
    video_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    if video_fps <= 0:
        video_fps = 30.0
    frames_filtro = max(1, int(round(video_fps * FILTRO_SEGUNDOS / max(1, SKIP_FRAMES))))
    frames_iniciales = int(round(video_fps * SEGUNDOS_INICIALES_SIN_CONTAR))
    print(f"FPS: {video_fps:.1f} | Filtro: {frames_filtro} frames | Zonas: {tipos_zonas}")

    estado_zona = {}
    frames_consecutivos = {}
    gestor_identidades = FleetIdentityManager(
        max_camiones=MAX_CAMIONES,
        margen_perturbacion=MARGEN_PERTURBACION_PX,
        frames_post_perturbacion=max(1, int(round(video_fps * SEGUNDOS_POST_PERTURBACION))),
        iou_min_protegido=IOU_MIN_PROTEGIDO,
        frames_confirmar_fuera=max(1, int(round(video_fps * SEGUNDOS_CONFIRMAR_SALIDA))),
        frames_olvidar=max(1, int(round(video_fps * SEGUNDOS_OLVIDAR_PERDIDO))),
        frames_confirmar_entrada=max(1, int(round(video_fps * SEGUNDOS_CONFIRMAR_ENTRADA))),
    )
    cajas_visuales = {}
    poligonos_camion = {}   # ultima caja rotada de cada camion (si el modelo es OBB)
    contador_frames = 0
    prev_time = time.time()
    if getattr(model, "task", "") == "obb":
        print("Modelo de cajas rotadas (OBB) detectado.")

    ancho_leyenda, alto_leyenda = medir_leyenda()
    ancho_panel, alto_panel = medir_panel(tipos_zonas)
    ubicador_panel = UbicadorElemento(ANCHO_VISUAL, ALTO_VISUAL, ancho_panel, alto_panel,
                                      MARGEN_LEYENDA_PX, video_fps, POSICION_PANEL)
    ubicador_leyenda = UbicadorElemento(ANCHO_VISUAL, ALTO_VISUAL, ancho_leyenda, alto_leyenda,
                                        MARGEN_LEYENDA_PX, video_fps, POSICION_LEYENDA)
    ubicador_leyenda.calor = ubicador_panel.calor   # comparten el mapa de calor de camiones
    if seleccion["panel_pos"] is not None:
        ubicador_panel.rect_fijo = rect_elemento(seleccion["panel_pos"], ancho_panel, alto_panel)
    if seleccion["leyenda_pos"] is not None:
        ubicador_leyenda.rect_fijo = rect_elemento(seleccion["leyenda_pos"], ancho_leyenda, alto_leyenda)
    (tw_rend, th_rend), base_rend = cv2.getTextSize("RENDIMIENTO: 999 FPS",
                                                    cv2.FONT_HERSHEY_TRIPLEX, 0.6, 2)
    rect_rendimiento = (10, 30 - th_rend - 6, 15 + tw_rend + 6, 30 + base_rend + 6)

    registro = None
    if EXPORTAR_DATOS:
        try:
            import pandas  # noqa: F401
            import openpyxl  # noqa: F401
        except ImportError as error:
            import sys
            print("=" * 70)
            print(f"AVISO: falta la libreria '{error.name}'; al final NO se podra exportar a Excel.")
            print("Cierra el programa (q) e instalala en este Python con:")
            print(f'    "{sys.executable}" -m pip install pandas openpyxl')
            print("=" * 70)
        ancho_orig = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or ANCHO_VISUAL
        alto_orig = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or ALTO_VISUAL
        registro = RegistroDatos(
            VIDEO_PATH, video_fps, math.ceil(SKIP_FRAMES), zonas, tipos_zonas,
            escala_x=ancho_orig / ANCHO_VISUAL, escala_y=alto_orig / ALTO_VISUAL,
            resolucion_original=(ancho_orig, alto_orig))

    ventana_principal = "Control de Procesos - Aldair Toledo"
    cv2.namedWindow(ventana_principal, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(ventana_principal, ANCHO_VENTANA, ALTO_VENTANA)
    try:
        while cap.isOpened():
            success, frame_original = cap.read()
            if not success:
                break
            contador_frames += 1
            frame = cv2.resize(frame_original, (ANCHO_VISUAL, ALTO_VISUAL))
            tracks_actuales = []
            # Acepta decimales: 1.5 analiza 2 de cada 3 cuadros, 2 analiza 1 de cada 2, etc.
            ejecutar_inferencia = (SKIP_FRAMES <= 1 or contador_frames == 1 or
                                   int(contador_frames / SKIP_FRAMES) != int((contador_frames - 1) / SKIP_FRAMES))

            if ejecutar_inferencia:
                resultados = model.track(source=frame, conf=CONF_DETECCION, imgsz=IMGSZ_DETECCION,
                                         iou=IOU_NMS, tracker=TRACKER_CONFIG, persist=True,
                                         device=dispositivo, verbose=False)
                resultado = resultados[0] if resultados else None
                observaciones = []
                poligonos_internos = {}
                # Modelo OBB (cajas rotadas) -> resultado.obb ; modelo normal -> resultado.boxes
                det = None
                if resultado is not None:
                    det = resultado.obb if getattr(resultado, "obb", None) is not None else resultado.boxes
                if det is not None and det.id is not None:
                    ids = det.id.int().cpu().tolist()
                    cajas = det.xyxy.cpu().tolist()
                    poligonos = det.xyxyxyxy.cpu().numpy() if hasattr(det, "xyxyxyxy") else [None] * len(ids)
                    for track_id, coordenadas, poligono in zip(ids, cajas, poligonos):
                        x1, y1, x2, y2 = [int(valor) for valor in coordenadas]
                        caja = (x1, y1, max(1, x2 - x1), max(1, y2 - y1))
                        observaciones.append((track_id, caja))
                        if poligono is not None:
                            # Se guarda relativo al centro de la caja para poder moverlo con ella.
                            cx, cy = centro_caja(caja)
                            poligonos_internos[track_id] = np.asarray(poligono, np.float32) - [cx, cy]

                for persistent_id, caja_cruda, internal_id in gestor_identidades.actualizar(observaciones, contador_frames):
                    tracks_actuales.append((persistent_id, caja_cruda))
                    if internal_id in poligonos_internos and \
                            gestor_identidades.estados.get(persistent_id) == "DETECTADO":
                        poligonos_camion[persistent_id] = poligonos_internos[internal_id]
                    anterior = cajas_visuales.get(persistent_id)
                    if anterior is not None and iou_cajas(anterior, caja_cruda) > 0.3:
                        s = SUAVIZADO_VISUAL
                        cajas_visuales[persistent_id] = tuple(
                            int(round(s * a + (1 - s) * n)) for a, n in zip(anterior, caja_cruda))
                    else:
                        cajas_visuales[persistent_id] = caja_cruda

            elif MOSTRAR_CAJAS_EN_FRAMES_OMITIDOS:
                # Extrapolacion solo visual; no se usa para contar.
                for persistent_id, record in gestor_identidades.records.items():
                    if record["state"] != "ACTIVE" or record["bbox"] is None:
                        continue
                    frames_desde_deteccion = contador_frames - record["last_frame"]
                    cajas_visuales[persistent_id] = tuple(
                        max(1, int(valor + vel * frames_desde_deteccion))
                        for valor, vel in zip(record["bbox"], record["velocity"]))

            # Solo se dibujan camiones vistos realmente (sin cajas "fantasma").
            cajas_a_dibujar = [
                (track_id, caja) for track_id, caja in cajas_visuales.items()
                if gestor_identidades.records.get(track_id, {}).get("state") == "ACTIVE"
            ]

            # Conteo por zonas (solo en frames con inferencia real).
            if ejecutar_inferencia:
                for track_id, caja in tracks_actuales:
                    for zona_id, zona in enumerate(zonas):
                        observado = clasificar_en_zona(caja, zona, tipos_zonas[zona_id])
                        key = (track_id, zona_id)
                        confirmado = estado_zona.get(key, "fuera")
                        if observado == "dentro" and confirmado == "fuera":
                            frames_consecutivos[key] = frames_consecutivos.get(key, 0) + 1
                            if frames_consecutivos[key] >= frames_filtro:
                                if contador_frames > frames_iniciales:
                                    totales_por_zona[zona_id] += 1
                                if tipos_zonas[zona_id] == "dinamica":
                                    ocupacion_actual[zona_id] = ocupacion_actual.get(zona_id, 0) + 1
                                estado_zona[key] = "dentro"
                                frames_consecutivos[key] = 0
                                if registro is not None:
                                    registro.evento(contador_frames, track_id, zona_id, "ENTRADA",
                                                    contado=contador_frames > frames_iniciales)
                        elif observado == "fuera" and confirmado == "dentro":
                            frames_consecutivos[key] = frames_consecutivos.get(key, 0) + 1
                            if frames_consecutivos[key] >= frames_filtro:
                                estado_zona[key] = "fuera"
                                frames_consecutivos[key] = 0
                                if registro is not None:
                                    registro.evento(contador_frames, track_id, zona_id, "SALIDA")
                                if tipos_zonas[zona_id] == "dinamica":
                                    ocupacion_actual[zona_id] = max(0, ocupacion_actual.get(zona_id, 0) - 1)
                        else:
                            # Caja en transicion: se mantiene el estado anterior.
                            frames_consecutivos[key] = 0

                if registro is not None:
                    registro.registrar(contador_frames, tracks_actuales, gestor_identidades.estados,
                                       gestor_identidades.records, estado_zona)

            # Ubicacion del panel y la leyenda (sobre el frame aun limpio).
            ubicador_panel.registrar_camiones(cajas_a_dibujar)
            prohibidos_panel = [rect_rendimiento]
            if ubicador_leyenda.rect_fijo is not None:
                prohibidos_panel.append(ubicador_leyenda.rect_fijo)
            rect_panel = ubicador_panel.elegir(contador_frames, frame, zonas, prohibidos_panel)
            rect_leyenda = ubicador_leyenda.elegir(contador_frames, frame, zonas,
                                                   [rect_panel, rect_rendimiento])

            # 1) Zonas (debajo de todo).
            rotulos_ocupados = []
            for zona_id, zona in enumerate(zonas):
                x, y, w, h = zona
                color = color_dinamica if tipos_zonas[zona_id] == "dinamica" else color_acumulativa
                dibujar_rectangulo_punteado(frame, (x, y), (x + w, y + h), color)

            # 2) Panel y leyenda (se reservan para que ninguna etiqueta los tape).
            rotulos_ocupados.append(rect_panel)
            rotulos_ocupados.append(rect_leyenda)

            # 3) Rotulos de zona: se colocan dentro de la zona si arriba chocan con camiones.
            rotulos_zona = []
            for zona_id, zona in enumerate(zonas):
                x, y, w, h = zona
                rect = (x, max(0, y - 20), x + 75, max(20, y))
                if any(rects_se_cruzan(rect, (cx, cy, cx + cw, cy + ch)) for _, (cx, cy, cw, ch) in cajas_a_dibujar):
                    rect = (x + 2, y + h - 20, x + 77, y + h - 2)
                rotulos_zona.append((zona_id, rect))
                rotulos_ocupados.append(rect)

            # 4) Camiones y etiquetas con su ID.
            dibujar_camiones(frame, cajas_a_dibujar, rotulos_ocupados, poligonos_camion)

            # 5) Rotulos de zona encima de todo.
            for zona_id, (rx1, ry1, rx2, ry2) in rotulos_zona:
                color = color_dinamica if tipos_zonas[zona_id] == "dinamica" else color_acumulativa
                cv2.rectangle(frame, (rx1, ry1), (rx2, ry2), color, -1)
                cv2.putText(frame, f"ZONA {zona_id + 1}", (rx1 + 8, ry2 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1, cv2.LINE_AA)

            # Panel compacto. El tiempo es el del video, no el reloj de la PC.
            valores_panel = [ocupacion_actual.get(z, 0) if tipos_zonas[z] == "dinamica"
                             else totales_por_zona.get(z, 0) for z in range(len(zonas))]
            tiempo_video = str(timedelta(seconds=int(contador_frames / video_fps)))
            dibujar_panel(frame, rect_panel, tipos_zonas, valores_panel, tiempo_video, colores_leyenda)

            dibujar_leyenda(frame, rect_leyenda, colores_leyenda)

            current_time = time.time()
            fps = 1 / max(current_time - prev_time, 1e-6)
            prev_time = current_time
            cv2.putText(frame, f"RENDIMIENTO: {int(fps)} FPS", (15, 30), cv2.FONT_HERSHEY_TRIPLEX, 0.6, (255, 255, 255), 2, cv2.LINE_AA)

            cv2.imshow(ventana_principal, frame)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break

    finally:
        # Se exporta siempre: al terminar el video, al presionar 'q' o si hay un error.
        cap.release()
        cv2.destroyAllWindows()
        if registro is not None:
            registro.exportar(CARPETA_SALIDA)


if __name__ == "__main__":
    main()
