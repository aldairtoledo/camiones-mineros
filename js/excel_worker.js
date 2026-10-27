// Arma el Excel del visitante DENTRO del navegador, con el mismo reporte_excel.py del proyecto.
// Corre en segundo plano (Web Worker) para que la pagina no se congele mientras tanto.
// Usa Pyodide (Python para el navegador), incluido en js/vendor/pyodide.
/* global importScripts, loadPyodide */
importScripts("vendor/pyodide/pyodide.js");

const VENDOR = new URL("vendor/pyodide/", self.location.href).href;
const RUEDAS = ["et_xmlfile-2.0.0-py3-none-any.whl", "openpyxl-3.1.5-py2.py3-none-any.whl"];
let listo = null;

async function preparar(urlReporte) {
  const py = await loadPyodide({ indexURL: VENDOR });
  // openpyxl y et_xmlfile son Python puro: basta con descomprimirlos en site-packages.
  for (const rueda of RUEDAS) {
    const datos = new Uint8Array(await (await fetch(VENDOR + rueda)).arrayBuffer());
    py.FS.writeFile(`/tmp/${rueda}`, datos);
    py.runPython(`
import zipfile, site
zipfile.ZipFile("/tmp/${rueda}").extractall(site.getsitepackages()[0])
`);
  }
  const codigo = await (await fetch(urlReporte, { cache: "no-cache" })).text();
  py.FS.writeFile("/home/pyodide/reporte_excel.py", codigo);
  py.runPython(`
import json, sys
sys.path.insert(0, "/home/pyodide")
import reporte_excel

class Calibracion:
    """Lo unico que reporte_excel usa de la Georreferencia: su descripcion y la escala."""
    def __init__(self, d, escala):
        self.info = dict((d or {}).get("info") or {})
        self.escala_m_px = escala

def armar(texto):
    entrada = json.loads(texto)
    datos = entrada["datos"]
    datos["resolucion"] = tuple(datos.get("resolucion") or (0, 0))
    datos["georef"] = (Calibracion(entrada["calibracion"], entrada["escala_m_px"])
                       if entrada.get("calibracion") else None)
    parametros = [tuple(p) for p in entrada.get("parametros") or []]
    reporte_excel.generar(datos, "/tmp/reporte.xlsx", parametros)
    with open("/tmp/reporte.xlsx", "rb") as f:
        return f.read()
`);
  return py;
}

self.onmessage = async (e) => {
  const { id, texto, urlReporte } = e.data;
  try {
    if (!listo) {
      self.postMessage({ id, paso: "Preparando Python en tu navegador (solo la primera vez)…" });
      listo = preparar(urlReporte);
    }
    const py = await listo;
    self.postMessage({ id, paso: "Armando tu Excel…" });
    const resultado = py.globals.get("armar")(texto);
    const bytes = resultado.toJs();
    resultado.destroy();
    self.postMessage({ id, bytes }, [bytes.buffer]);
  } catch (error) {
    listo = null;                                   // el siguiente intento empieza de cero
    self.postMessage({ id, error: String(error && error.message || error).slice(-600) });
  }
};
