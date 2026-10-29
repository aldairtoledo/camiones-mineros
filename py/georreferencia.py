"""Georreferenciacion: convierte posiciones del video (pixeles) en coordenadas reales
(Este, Norte en metros, por ejemplo UTM WGS84) a partir de puntos de control.

El usuario marca puntos sobre el video y escribe sus coordenadas. Segun cuantos puntos haya:
  2 puntos  -> similitud (escala + giro + desplazamiento). Rapido, supone vista desde arriba.
  3 puntos  -> afin (ademas corrige estiramientos distintos en cada eje).
  4 o mas   -> afin ajustada por minimos cuadrados: como sobran puntos, se puede medir
              el error (que tan bien encajan los puntos entre si).

Los pixeles son los de la resolucion original del video (origen arriba a la izquierda,
el eje y hacia abajo). Sirve igual para la app de escritorio y para la version web.
"""
import math

import cv2
import numpy as np

METODOS = {2: "Similitud (2 puntos)", 3: "Afín (3 puntos)"}


class Georreferencia:
    def __init__(self, puntos, info=None):
        """puntos: lista de (x_px, y_px, este_m, norte_m), al menos 2.
        info: datos de como se calibro (modo, largo del camion, distancias...)."""
        self.info = dict(info or {})
        self.puntos = [tuple(float(v) for v in p) for p in puntos]
        if len(self.puntos) < 2:
            raise ValueError("Se necesitan al menos 2 puntos de control.")
        px = np.array([(p[0], p[1]) for p in self.puntos], np.float64)
        en = np.array([(p[2], p[3]) for p in self.puntos], np.float64)
        if np.ptp(px, axis=0).max() < 5:
            raise ValueError("Los puntos estan demasiado juntos en la imagen.")
        # Se trabaja relativo al primer punto para no perder precision con numeros UTM grandes.
        self.origen = en[0].copy()
        en_rel = en - self.origen
        n = len(self.puntos)
        if n == 2:
            self.matriz = self._similitud(px, en_rel)
            self.metodo = METODOS[2]
        elif n == 3:
            m = cv2.getAffineTransform(px.astype(np.float32), en_rel.astype(np.float32))
            if not np.all(np.isfinite(m)) or abs(np.linalg.det(m[:, :2])) < 1e-12:
                raise ValueError("Los 3 puntos no pueden estar en linea recta.")
            self.matriz = np.vstack([m.astype(np.float64), [0, 0, 1]])
            self.metodo = METODOS[3]
        else:
            a = np.hstack([px, np.ones((n, 1))])
            sol, _, rango, _ = np.linalg.lstsq(a, en_rel, rcond=None)
            if rango < 3:
                raise ValueError("Los puntos no pueden estar todos en linea recta.")
            self.matriz = np.vstack([sol.T, [0, 0, 1]])
            self.metodo = f"Afín por mínimos cuadrados ({n} puntos)"
        self.residuos = [math.hypot(*(np.array(self.a_coordenadas(p[0], p[1])) - [p[2], p[3]]))
                         for p in self.puntos]
        self.error_m = math.sqrt(sum(r * r for r in self.residuos) / n)
        self.escala_m_px = float(self._escala_media())

    @staticmethod
    def _similitud(px, en):
        """Similitud exacta con 2 puntos. La imagen tiene y hacia abajo y el Norte va hacia
        arriba, por eso se invierte y antes de calcular."""
        w = px[:, 0] - 1j * px[:, 1]
        z = en[:, 0] + 1j * en[:, 1]
        if abs(w[1] - w[0]) < 1e-9:
            raise ValueError("Los 2 puntos estan en el mismo lugar de la imagen.")
        a = (z[1] - z[0]) / (w[1] - w[0])
        b = z[0] - a * w[0]
        # E + iN = a * (x - i y) + b
        return np.array([[a.real, a.imag, b.real],
                         [a.imag, -a.real, b.imag],
                         [0.0, 0.0, 1.0]])

    def a_coordenadas(self, x, y):
        """Pixel (x, y) de la resolucion original -> (Este, Norte) en metros."""
        v = self.matriz @ np.array([x, y, 1.0])
        if abs(v[2]) < 1e-12:
            return float("nan"), float("nan")
        return float(v[0] / v[2] + self.origen[0]), float(v[1] / v[2] + self.origen[1])

    def a_pixel(self, este, norte):
        """(Este, Norte) -> pixel (x, y) de la resolucion original (inversa)."""
        inv = np.linalg.inv(self.matriz)
        v = inv @ np.array([este - self.origen[0], norte - self.origen[1], 1.0])
        return float(v[0] / v[2]), float(v[1] / v[2])

    def _escala_media(self):
        xs = [p[0] for p in self.puntos]
        ys = [p[1] for p in self.puntos]
        cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
        e0 = np.array(self.a_coordenadas(cx, cy))
        e1 = np.array(self.a_coordenadas(cx + 10, cy))
        e2 = np.array(self.a_coordenadas(cx, cy + 10))
        return (np.linalg.norm(e1 - e0) + np.linalg.norm(e2 - e0)) / 20.0

    def es_plano(self):
        return self.info.get("modo") == "plano"

    def origen_plano(self):
        """Coordenadas de la esquina inferior izquierda (el (0; 0) del plano local)."""
        return self.info.get("origen_e", 0.0), self.info.get("origen_n", 0.0)

    def a_plano(self, x, y):
        """Pixel -> (X, Y) en metros con origen en la esquina inferior izquierda del video."""
        e, n = self.a_coordenadas(x, y)
        e0, n0 = self.origen_plano()
        return e - e0, n - n0

    def descripcion(self):
        if self.es_plano():
            i = self.info
            filas = [("Metodo", "Plano local: origen (0; 0) en la esquina inferior izquierda, X a la "
                                "derecha, Y hacia arriba"),
                     ("Escala calibrada con", i.get("fuente", "-")),
                     ("Escala (m por pixel)", round(self.escala_m_px, 4)),
                     ("Largo del camion usado (m)", i.get("largo_m", "-")),
                     ("Ancho del camion usado (m)", i.get("ancho_m") or "-"),
                     ("Largo medido en el video (px)", i.get("largo_px", "-")),
                     ("Camiones medidos", i.get("camiones_medidos", "-")),
                     ("Precision aproximada de posicion (m)", i.get("precision_m", "-")),
                     ("Coordenadas del origen (E, N)", f"{self.origen_plano()[0]:.2f}, {self.origen_plano()[1]:.2f}")]
            for k, (x1, y1, x2, y2, m) in enumerate(i.get("distancias", []), 1):
                filas.append((f"Distancia conocida {k}",
                              f"({x1:.0f}, {y1:.0f}) a ({x2:.0f}, {y2:.0f}) px = {m:.2f} m"))
            return filas
        error = (round(self.error_m, 3) if self.error_medible()
                 else "no se puede medir con 2 o 3 puntos (usa 4 o mas)")
        filas = [("Metodo", self.metodo),
                 ("Error medio de los puntos de control (m)", error),
                 ("Escala aproximada (m por pixel)", round(self.escala_m_px, 4))]
        for i, (x, y, e, n) in enumerate(self.puntos, 1):
            filas.append((f"Punto de control {i}", f"pixel ({x:.0f}, {y:.0f})  ->  E {e:.2f}  N {n:.2f}"))
        return filas

    def error_medible(self):
        return len(self.puntos) >= 4

    def a_dict(self):
        return {"puntos": [list(p) for p in self.puntos], "info": self.info}

    @classmethod
    def desde_dict(cls, datos):
        return cls(datos["puntos"], datos.get("info"))


def plano_local(ancho_px, alto_px, escala_m_px, origen_e=0.0, origen_n=0.0, info=None):
    """Plano cartesiano en metros: (0; 0) en la esquina inferior izquierda del video,
    X hacia la derecha y Y hacia arriba. Si se dan las coordenadas del origen (por ejemplo
    UTM), tambien se obtienen Este y Norte."""
    if not escala_m_px or escala_m_px <= 0:
        raise ValueError("La escala debe ser mayor que cero.")
    datos = dict(info or {})
    datos.update(modo="plano", origen_e=float(origen_e), origen_n=float(origen_n),
                 escala_m_px=float(escala_m_px))
    return Georreferencia([(0, alto_px, origen_e, origen_n),
                           (ancho_px, alto_px, origen_e + ancho_px * escala_m_px, origen_n)], datos)


def paso_grilla(ancho_m, lineas=8):
    """Separacion 'redonda' de la grilla para que entren unas 'lineas' lineas."""
    bruto = max(ancho_m / max(lineas, 1), 1e-6)
    base = 10 ** math.floor(math.log10(bruto))
    for m in (1, 2, 2.5, 5, 10):
        if m * base >= bruto:
            return m * base
    return 10 * base


def ejemplo(ancho_px, alto_px, ancho_m=400.0, este=350000.0, norte=8460000.0):
    """Georreferencia de ejemplo para probar: la esquina inferior izquierda del video es
    (E 350 000, N 8 460 000) -zona UTM 18S, cerca de Lima-, el video mide 'ancho_m' metros
    de ancho y el Norte apunta hacia arriba."""
    escala = ancho_m / ancho_px
    return Georreferencia([(0, alto_px, este, norte),
                           (ancho_px, alto_px, este + ancho_m, norte),
                           (0, 0, este, norte + alto_px * escala),
                           (ancho_px, 0, este + ancho_m, norte + alto_px * escala)])
