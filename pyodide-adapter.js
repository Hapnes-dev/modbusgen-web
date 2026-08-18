/* Pyodide backend for the modbusgen GUI: replaces the local-server /api/* calls with
 * in-browser Python. Included only in the static web build (build_web.py); the page
 * detects it via window.PYODIDE_API. Everything runs client-side - no data leaves
 * the browser. */
"use strict";

const PYODIDE_VERSION = "0.26.4";
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const STATIC_PROJECTS = ["example-kjol.json", "example-em24-gavazzi.json",
                         "example-belimo-ev.json"];

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
  await new Promise((ok, bad) => { s.onload = ok; s.onerror = bad; });
  const py = await loadPyodide({ indexURL: PYODIDE_URL });
  _overlay("Loading YAML support…");
  await py.loadPackage("pyyaml");
  _overlay("Loading modbusgen…");
  const buf = await (await fetch("modbusgen-src.zip")).arrayBuffer();
  py.unpackArchive(buf, "zip");
  py.runPython("import sys; sys.path.insert(0, 'src')");
  const glue = py.pyimport("modbusgen.webapi");
  document.getElementById("pyodideOverlay")?.remove();
  return glue;
})().catch(e => {
  _overlay("Failed to load the Python runtime: " + (e.message || e) +
           " - check your internet connection and reload.", true);
  throw e;
});

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
  if (path === "/api/yaml")
    return { text: glue.yaml_text(JSON.stringify(body.project)) };
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
