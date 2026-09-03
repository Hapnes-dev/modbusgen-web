/* Pyodide backend for the modbusgen GUI: replaces the local-server /api/* calls with
 * in-browser Python. Included only in the static web build (build_web.py); the page
 * detects it via window.PYODIDE_API. Everything runs client-side - no data leaves
 * the browser. */
"use strict";

const PYODIDE_VERSION = "0.26.4";
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const STATIC_PROJECTS = ["example-belimo-ev.json"];
const XLSM_TEMPLATE = "Modbustemplate.xlsm?v=c69048c74c";     // copied in by build_web.py
const XLSM_VFS_PATH = "/modbustemplate.xlsm";    // where it lands inside Pyodide

let _py = null;              // the runtime itself, for FS access and micropip
let _openpyxlReady = null;   // one-shot: openpyxl installed (import and export)
let _templateReady = null;   // one-shot: the blank workbook is in the VFS (export)

function _overlay(text, error) {
  let div = document.getElementById("pyodideOverlay");
  if (!div) {
    div = document.createElement("div");
    div.id = "pyodideOverlay";
    div.style.cssText = "position:fixed;inset:0;background:rgba(16,18,22,.92);" +
      "display:flex;align-items:center;justify-content:center;z-index:99;" +
      "color:#d7dae0;font:15px 'Segoe UI',sans-serif;text-align:center;padding:20px";
    document.body.append(div);
  }
  div.textContent = text;
  div.style.color = error ? "#ff6b6b" : "#d7dae0";
  return div;
}

window.PYODIDE_READY = (async () => {
  _overlay("Loading Python runtime (~10 MB on first visit)…");
  const s = document.createElement("script");
  s.src = PYODIDE_URL + "pyodide.js";
  document.head.append(s);
  // a script error event carries no message: rejecting with it raw reported the
  // outage to the user as "[object Event]"
  await new Promise((ok, bad) => {
    s.onload = ok;
    s.onerror = () => bad(new Error("could not fetch " + s.src));
  });
  const py = _py = await loadPyodide({ indexURL: PYODIDE_URL });
  _overlay("Loading YAML support…");
  await py.loadPackage("pyyaml");
  _overlay("Loading modbusgen…");
  const buf = await (await fetch("modbusgen-src.zip?v=c297d0c943")).arrayBuffer();
  py.unpackArchive(buf, "zip");
  py.runPython("import sys; sys.path.insert(0, 'src')");
  const glue = py.pyimport("modbusgen.webapi");
  document.getElementById("pyodideOverlay")?.remove();
  return glue;
})().catch(e => {
  const err = e instanceof Error ? e : new Error(String(e && e.message || e));
  _overlay("Failed to load the Python runtime: " + err.message +
           " - check your internet connection and reload.", true);
  throw err;      // every /api/* call from here on rejects, and the page says so
});
/* The page reports the failure itself (init() -> bootstrapFailed). This only stops
   the browser logging "Uncaught (in promise)" in the window between the runtime
   giving up and the first api() call awaiting it - it does not consume the
   rejection, so window.PYODIDE_READY still rejects for everyone who awaits it. */
window.PYODIDE_READY.catch(() => {});

/* Excel support is ~1 MB nobody should pay for just to open the page, so it loads on
   first use and is cached for the session. Split in two because reading a workbook
   needs only the library, while writing one also needs the 640 KB blank template -
   which goes into Pyodide's own filesystem so the bytes never cross the JSON
   boundary. A failure clears the promise so the next click retries. */
function _ensureOpenpyxl() {
  if (_openpyxlReady) return _openpyxlReady;
  _openpyxlReady = (async () => {
    _overlay("Loading Excel support (~1 MB, first use only)…");
    try {
      await _py.loadPackage("micropip");
      await _py.pyimport("micropip").install("openpyxl");
    } catch (e) {
      _openpyxlReady = null;
      throw new Error("could not load Excel support: " + (e.message || e));
    } finally {
      document.getElementById("pyodideOverlay")?.remove();
    }
  })();
  return _openpyxlReady;
}

function _ensureTemplate() {
  if (_templateReady) return _templateReady;
  _templateReady = (async () => {
    try {
      const r = await fetch(XLSM_TEMPLATE);
      if (!r.ok) throw new Error(`${XLSM_TEMPLATE} (HTTP ${r.status})`);
      _py.FS.writeFile(XLSM_VFS_PATH, new Uint8Array(await r.arrayBuffer()));
    } catch (e) {
      _templateReady = null;
      throw new Error("could not load the Modbustemplate workbook: " + (e.message || e));
    }
  })();
  return _templateReady;
}

function _downloadB64(name, b64) {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  _downloadBlob(name, new Blob([bytes], { type: "text/plain" }));
}
function _downloadText(name, text) {
  _downloadBlob(name, new Blob([text], { type: "text/plain;charset=utf-8" }));
}
function _downloadBlob(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

window.PYODIDE_API = async (path, body) => {
  const glue = await window.PYODIDE_READY;
  if (path === "/api/bootstrap") {
    const data = JSON.parse(glue.bootstrap_json());
    data.projects = STATIC_PROJECTS;
    return data;
  }
  if (path.startsWith("/api/project")) {
    const file = decodeURIComponent(path.split("file=")[1] || "");
    if (!STATIC_PROJECTS.includes(file)) throw new Error("unknown example: " + file);
    return await (await fetch("projects/" + file)).json();
  }
  if (path === "/api/validate")
    return JSON.parse(glue.validate_json(JSON.stringify(body.project)));
  if (path === "/api/generate") {
    const res = JSON.parse(glue.generate_json(JSON.stringify(body.project)));
    if (body.save && res.errors && !res.errors.length) {
      _downloadB64(res.filename, res.b64);
      res.written = res.filename + " (downloaded)";
    }
    return res;
  }
  if (path === "/api/parse") {
    const res = JSON.parse(glue.parse_project(body.text));
    if (res.error) throw new Error(res.error);
    return res.project;
  }
  if (path === "/api/import-sql") {
    const res = JSON.parse(glue.import_sql_json(body.text));
    if (res.error) throw new Error(res.error);
    return res;
  }
  if (path === "/api/canonical")
    return JSON.parse(glue.canonical_json(JSON.stringify(body.project)));
  if (path === "/api/yaml")
    return { text: glue.yaml_text(JSON.stringify(body.project)) };
  if (path === "/api/xlsm") {
    await _ensureOpenpyxl();
    await _ensureTemplate();
    return JSON.parse(glue.xlsm_json(JSON.stringify(body.project), XLSM_VFS_PATH));
  }
  /* Promoting a datatype writes data/tables/datatypes.csv, and there is no filesystem
     here to write it to. The page hides the button on this backend (writable_tables is
     false), so reaching this is a bug rather than a user action - answer with the
     reason instead of an exception nobody can act on. */
  if (path === "/api/datatype-promote")
    return { error: "the web app cannot write the shared datatype table - it has no " +
                    "filesystem. The variable stays in this project and travels with " +
                    "the file; promote it from the local GUI to share it." };
  if (path === "/api/import-xlsm") {
    await _ensureOpenpyxl();          // reading a workbook needs no template
    const res = JSON.parse(glue.import_xlsm_json(body.b64, body.filename || ""));
    if (res.error) throw new Error(res.error);
    return res;
  }
  if (path === "/api/save") {
    const name = body.file || "project.yaml";
    if (name.endsWith(".json")) {
      const clean = JSON.parse(glue.validate_json(JSON.stringify(body.project)));
      if (clean.errors.length) throw new Error(clean.errors[0]);
      _downloadText(name, JSON.stringify(body.project, null, 2));
    } else {
      _downloadText(name, glue.yaml_text(JSON.stringify(body.project)));
    }
    return { saved: name + " (downloaded)" };
  }
  throw new Error("unknown api path: " + path);
};
