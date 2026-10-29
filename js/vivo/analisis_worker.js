// "Analizar mi video" -> "En mi computadora": corre motor.py (el mismo de la app de escritorio)
// con Pyodide, en segundo plano, mientras la pagina detecta los camiones con la tarjeta grafica.
// Recibe, cuadro por cuadro, lo que encontro ByteTrack y al final devuelve demo.json y
// resultados.json (lo mismo que genera exportar_demo.py en la laptop). Ver py/analisis_web.py.
import { loadPyodide } from "../vendor/pyodide/pyodide.mjs";
import { asignacionLineal } from "./seguimiento.js";

const VENDOR = new URL("../vendor/pyodide/", import.meta.url).href;
const CARPETA_PY = new URL("../../py/", import.meta.url).href;
const ARCHIVOS_PY = ["analisis_web.py", "exportar_demo.py", "motor.py", "deteccion_camiones.py", "eventos.py",
                     "georreferencia.py", "reporte_excel.py"];
const RUEDAS = ["et_xmlfile-2.0.0-py3-none-any.whl", "openpyxl-3.1.5-py2.py3-none-any.whl"];

let py = null, analisis = null, hechos = 0;

// La asignacion optima de la flota (scipy.optimize.linear_sum_assignment) la hace la pagina:
// seguimiento.js da exactamente el mismo resultado que scipy.
self.asignarFlota = (matriz) => {
  const m = matriz.toJs ? matriz.toJs() : matriz;
  if (matriz.destroy) matriz.destroy();
  return asignacionLineal(m);
};

async function preparar() {
  const p = await loadPyodide({ indexURL: VENDOR });
  await p.loadPackage("numpy");
  for (const rueda of RUEDAS) {
    p.FS.writeFile(`/tmp/${rueda}`, new Uint8Array(await (await fetch(VENDOR + rueda)).arrayBuffer()));
    p.runPython(`import zipfile, site\nzipfile.ZipFile("/tmp/${rueda}").extractall(site.getsitepackages()[0])`);
  }
  p.FS.mkdirTree("/home/pyodide/py");
  for (const a of ARCHIVOS_PY) {
    const r = await fetch(CARPETA_PY + a, { cache: "no-cache" });
    if (!r.ok) throw new Error(`Falta el archivo py/${a} en la página.`);
    p.FS.writeFile(`/home/pyodide/py/${a}`, await r.text());
  }
  p.runPython(`
import sys
sys.path.insert(0, "/home/pyodide/py")
import analisis_web
from js import asignarFlota

def _asignar(matriz, filas, columnas):
    r = asignarFlota(matriz)
    return [list(r[0]), list(r[1])]

analisis_web.instalar_reemplazos(_asignar)
`);
  return p;
}

// Los mensajes se atienden de uno en uno y en orden (mientras Python se prepara, los cuadros esperan).
let cola = Promise.resolve();
self.onmessage = (e) => { cola = cola.then(() => atender(e.data)); };

async function atender(m) {
  try {
    if (m.tipo === "iniciar") {
      self.postMessage({ tipo: "paso", texto: "Preparando Python en tu navegador…" });
      py = py || await preparar();
      const Analisis = py.globals.get("analisis_web").Analisis;
      if (analisis) analisis.destroy();
      analisis = Analisis(m.nombre, m.ancho, m.alto, m.fps, m.total, m.modo, m.skip, m.largo,
                          py.toPy(m.polisPrimer || []));
      hechos = 0;
      self.postMessage({ tipo: "listo", calibracion: analisis.calibracion ?? null });
    } else if (m.tipo === "paso") {
      // undefined llega a Python como None (null llegaria como JsNull)
      analisis.paso(m.camiones ? JSON.stringify(m.camiones) : undefined, m.polis ? JSON.stringify(m.polis) : undefined);
      hechos++;
      if (hechos % 15 === 0) self.postMessage({ tipo: "avance", hechos });
    } else if (m.tipo === "terminar") {
      const texto = analisis.terminar(m.dispositivo || "Tu computadora");
      self.postMessage({ tipo: "resultado", hechos, texto });
    }
  } catch (error) {
    self.postMessage({ tipo: "error", texto: String(error && error.message || error).slice(-800) });
  }
}
