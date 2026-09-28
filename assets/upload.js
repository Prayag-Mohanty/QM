/* Manage page: add, edit and delete quizzes by committing straight to the GitHub
   repo with the owner's token (Git Data API), which triggers the site rebuild.
   No server needed. */
(function () {
  "use strict";
  var root = document.getElementById("upload");
  if (!root) return;

  var API = "https://api.github.com";
  var REPO = root.dataset.repo;
  var BRANCH = root.dataset.branch || "main";
  var BASE = root.dataset.base || "/";
  var KEY = "qm-upload-token";
  var MAX = 300 * 1024 * 1024;  // keep the whole site well inside GitHub Pages' 1 GB
  var CHUNK = 15 * 1024 * 1024; // GitHub's API rejects big requests, so large files go up in parts
  var DOC_EXT = ["pdf", "pptx", "ppt", "pps", "ppsx", "odp", "key", "docx", "doc", "odt"];
  var MANAGED = ["title", "description", "date", "event", "quizmaster", "quizmasters", "tags", "media"];

  var $ = function (id) { return document.getElementById(id); };
  var token = "";
  try { token = localStorage.getItem(KEY) || ""; } catch (e) { /* storage blocked */ }

  var quizzes = {};   // stem -> {stem, files: [{path, ext, size}], yml: {path, sha} | null}
  var published = {}; // slug -> entry from quizzes.json
  var editing = null; // {stem, yml, entries, text}
  var galleryRepo = { json: null, files: {} }; // pages/gallery.json sha, pages/gallery/<file> -> sha

  // ---- helpers -------------------------------------------------------------
  function request(method, path, body, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      // Never reuse a cached answer: the browser keeps GitHub GETs for up to a minute,
      // which made a second quick save build on an out-of-date version.
      if (method === "GET") path += (path.indexOf("?") === -1 ? "?" : "&") + "_=" + Date.now();
      xhr.open(method, API + path);
      xhr.setRequestHeader("Authorization", "Bearer " + token);
      xhr.setRequestHeader("Accept", "application/vnd.github+json");
      xhr.setRequestHeader("X-GitHub-Api-Version", "2022-11-28");
      if (onProgress) xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = function () {
        var data = null;
        try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch (e) { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else {
          var err = new Error((data && data.message) || ("GitHub error " + xhr.status));
          err.status = xhr.status;
          reject(err);
        }
      };
      xhr.onerror = function () { reject(new Error("Network error — check your connection and try again.")); };
      if (body !== undefined) {
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.send(JSON.stringify(body));
      } else xhr.send();
    });
  }

  function slugify(s) {
    s = s.normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
    return s.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "quiz";
  }
  function safeName(s) {
    return s.replace(/[\/\\:*?"<>|#%\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120).trim() || "Quiz";
  }
  function ext(name) { var m = /\.([a-z0-9]+)$/i.exec(name); return m ? m[1].toLowerCase() : ""; }
  function basename(stem) { return stem.split("/").pop(); }
  function human(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.ceil(n / 1024) + " KB"; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function list(s) { return s.split(",").map(function (t) { return t.trim(); }).filter(Boolean); }
  function today() { return new Date().toISOString().slice(0, 10); }
  function readBase64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(",")[1] || ""); };
      r.onerror = function () { reject(new Error("Could not read " + file.name)); };
      r.readAsDataURL(file);
    });
  }
  function utf8Base64(text) {
    var bytes = new TextEncoder().encode(text), bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function base64Utf8(b64) {
    var bin = atob(b64.replace(/\s/g, "")), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // ---- tiny YAML (the simple "key: value" files this site uses) -------------
  function unquote(v) {
    v = v.trim();
    if (v[0] === '"') { try { return JSON.parse(v); } catch (e) { return v.slice(1, -1); } }
    if (v[0] === "'") return v.slice(1, -1).replace(/''/g, "'");
    return v.replace(/\s+#.*$/, "");
  }
  function parseYaml(text) {
    var entries = [], cur = null;
    text.replace(/\r\n?/g, "\n").split("\n").forEach(function (line) {
      var m = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
      if (m) { cur = { key: m[1], head: m[2], lines: [line], more: [] }; entries.push(cur); }
      else if (cur && (/^\s/.test(line) || /^-\s/.test(line) || line === "")) { cur.lines.push(line); cur.more.push(line); }
      else { cur = null; entries.push({ key: null, lines: [line] }); }
    });
    var data = {};
    entries.forEach(function (e) {
      if (!e.key) return;
      var head = e.head.trim(), more = e.more.filter(function (l) { return l.trim(); });
      var value;
      if (/^[|>]/.test(head)) {
        var lines = e.more.slice(), indent = Math.min.apply(null, more.map(function (l) { return /^\s*/.exec(l)[0].length; }).concat([99]));
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        lines = lines.map(function (l) { return l.slice(indent); });
        value = head[0] === "|" ? lines.join("\n") : lines.join(" ").replace(/\s+/g, " ").trim();
      } else if (head === "" && more.length && more.every(function (l) { return /^\s*-\s/.test(l); })) {
        value = more.map(function (l) { return unquote(l.replace(/^\s*-\s/, "")); });
      } else if (head[0] === "[") {
        try { value = JSON.parse(head); } catch (err) { value = head.slice(1, -1).split(",").map(unquote).filter(Boolean); }
      } else value = unquote(head);
      data[e.key] = value;
    });
    return { entries: entries, data: data };
  }
  function asList(v) { return Array.isArray(v) ? v.map(String) : v ? list(String(v)) : []; }
  function buildYaml(parsed, fields) {
    var out = [], written = {};
    function emit(key) {
      if (written[key]) return;
      written[key] = true;
      var v = fields[key];
      if (Array.isArray(v) ? !v.length : !v) return;
      out.push(key + ": " + (key === "date" ? v : JSON.stringify(v))); // JSON strings/arrays are valid YAML
    }
    (parsed ? parsed.entries : []).forEach(function (e) {
      if (e.key && MANAGED.indexOf(e.key) !== -1) emit(e.key === "quizmasters" ? "quizmaster" : e.key);
      else out.push.apply(out, e.lines);
    });
    ["title", "description", "date", "event", "quizmaster", "tags", "media"].forEach(emit);
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out.join("\n") + "\n";
  }

  // ---- repo state ----------------------------------------------------------
  function loadRepo() {
    return request("GET", "/repos/" + REPO + "/git/ref/heads/" + BRANCH).then(function (ref) {
      return request("GET", "/repos/" + REPO + "/git/trees/" + ref.object.sha + "?recursive=1");
    }).then(function (tree) {
      quizzes = {};
      galleryRepo = { json: null, files: {} };
      tree.tree.forEach(function (item) {
        if (item.type === "blob" && item.path === "pages/gallery.json") galleryRepo.json = item.sha;
        if (item.type === "blob" && item.path.indexOf("pages/gallery/") === 0) galleryRepo.files[item.path.slice(14)] = item.sha;
        if (item.type !== "blob" || item.path.indexOf("quizzes/") !== 0) return;
        var clip = /^quizzes\/(.+)\.media\/((\d+)-[^/]+?)(\.part\d+)?$/.exec(item.path);
        if (clip) {
          var cq = quizzes[clip[1]] || (quizzes[clip[1]] = { stem: clip[1], files: [], yml: null });
          cq.clips = cq.clips || [];
          var c = cq.clips.filter(function (x) { return x.name === clip[2]; })[0];
          if (!c) cq.clips.push(c = { name: clip[2], slide: parseInt(clip[3], 10), size: 0, parts: [] });
          c.size += item.size;
          c.parts.push({ path: item.path, sha: item.sha });
          return;
        }
        var rel = item.path.slice(8), part = /^(.+)\.([a-z0-9]+)\.part\d+$/i.exec(rel);
        var e = part ? part[2].toLowerCase() : ext(rel);
        if (!e || basename(rel)[0] === ".") return;
        var stem = part ? part[1] : rel.slice(0, -(e.length + 1));
        var isYml = !part && (e === "yml" || e === "yaml");
        if (!isYml && DOC_EXT.indexOf(e) === -1) return;
        var q = quizzes[stem] || (quizzes[stem] = { stem: stem, files: [], yml: null });
        if (isYml) { q.yml = { path: item.path, sha: item.sha }; return; }
        // A big file stored as several .partNN pieces is still one file here.
        var f = q.files.filter(function (x) { return x.ext === e; })[0];
        if (!f) q.files.push(f = { ext: e, size: 0, paths: [] });
        f.size += item.size;
        f.paths.push(item.path);
      });
      Object.keys(quizzes).forEach(function (s) { if (!quizzes[s].files.length) delete quizzes[s]; });
      return fetch(BASE + "quizzes.json?t=" + Date.now()).then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
    }).then(function (items) {
      published = {};
      items.forEach(function (it) { published[it.url.replace(/\/$/, "").split("/").pop()] = it; });
      renderList();
      return loadPhotos();
    });
  }
  function slugOf(stem) { return slugify(basename(stem)); }
  function pageUrl(stem) { return location.origin + BASE + "quiz/" + slugOf(stem) + "/"; }

  function renderList() {
    var stems = Object.keys(quizzes).sort(function (a, b) {
      var pa = published[slugOf(a)], pb = published[slugOf(b)];
      return ((pb && pb.date) || "9999").localeCompare((pa && pa.date) || "9999") || a.localeCompare(b);
    });
    $("quiz-count").textContent = stems.length;
    var q = ($("filter").value || "").toLowerCase();
    var html = stems.filter(function (s) {
      var p = published[slugOf(s)];
      return !q || (s + " " + (p ? p.title : "")).toLowerCase().indexOf(q) !== -1;
    }).map(function (s) {
      var p = published[slugOf(s)], files = quizzes[s].files.map(function (f) { return f.ext.toUpperCase(); }).join(" + ");
      return '<li class="manage-item">' +
        (p ? '<img src="' + esc(p.cover) + '" alt="" loading="lazy">' : '<span class="manage-ph">new</span>') +
        '<span class="manage-text"><b>' + esc(p ? p.title : basename(s)) + "</b>" +
        '<span class="muted small">' + (p ? esc(p.date) + " · " + p.slides + " slides · " : "Publishing… · ") + files + "</span></span>" +
        '<span class="manage-actions">' +
        (p ? '<a class="btn btn-sm" href="' + esc(p.url) + '" target="_blank" rel="noopener">View</a>' : "") +
        '<button class="btn btn-sm btn-primary" type="button" data-edit="' + esc(s) + '">Edit</button></span></li>';
    }).join("");
    $("manage-list").innerHTML = html || '<li class="muted">' + (stems.length ? "No quizzes match." : "No quizzes yet — add one with “New quiz”.") + "</li>";
  }
  $("filter").addEventListener("input", renderList);
  $("manage-list").addEventListener("click", function (e) {
    var b = e.target.closest("[data-edit]");
    if (b) startEdit(b.dataset.edit);
  });

  // ---- tabs & modes --------------------------------------------------------
  function showTab(which) {
    $("manage").hidden = which !== "manage";
    $("photos").hidden = which !== "photos";
    $("quiz-form").hidden = which !== "new";
    ["new", "manage", "photos"].forEach(function (t) {
      $("tab-" + t).classList.toggle("is-active", t === which);
      $("tab-" + t).setAttribute("aria-selected", String(t === which));
    });
  }
  $("tab-new").addEventListener("click", function () { if (editing) resetForm(); showTab("new"); });
  $("tab-manage").addEventListener("click", function () { showTab("manage"); });
  $("tab-photos").addEventListener("click", function () { showTab("photos"); });

  function resetForm() {
    editing = null;
    $("quiz-form").reset();
    $("date").value = today();
    setFiles([]);
    $("edit-banner").hidden = true;
    $("current-files").hidden = true;
    $("current-clips").hidden = true;
    $("current-clips").innerHTML = "";
    newClips = [];
    renderClips();
    $("delete").hidden = true;
    $("submit").textContent = "Publish quiz";
    $("drop-title").textContent = "Choose or drop quiz files";
    $("drop-hint").innerHTML = "PDF and/or PPTX of the <em>same</em> quiz. Upload the PDF too for pixel-perfect viewing.";
    $("tab-new").textContent = "+ New quiz";
  }
  $("edit-cancel").addEventListener("click", function () { resetForm(); showTab("manage"); });

  function startEdit(stem) {
    var q = quizzes[stem];
    if (!q) return;
    var p = published[slugOf(stem)] || {};
    var load = q.yml
      ? request("GET", "/repos/" + REPO + "/git/blobs/" + q.yml.sha).then(function (b) { return base64Utf8(b.content); })
      : Promise.resolve("");
    load.then(function (text) {
      var parsed = parseYaml(text), d = parsed.data;
      resetForm();
      editing = { stem: stem, parsed: parsed, text: text };
      $("title").value = d.title || p.title || basename(stem);
      $("description").value = d.description || "";
      $("date").value = /^\d{4}-\d{2}-\d{2}$/.test(d.date || "") ? d.date : (p.date || "");
      $("event").value = d.event || p.event || "";
      $("quizmaster").value = asList(d.quizmaster || d.quizmasters).join(", ");
      $("tags").value = asList(d.tags || p.tags).join(", ");
      $("media").value = mediaToText(d.media);
      $("edit-name").textContent = $("title").value;
      $("edit-view").href = pageUrl(stem);
      $("edit-banner").hidden = false;
      $("current-files").innerHTML = "<b>Current files</b>" + q.files.map(function (f) {
        return '<label class="check"><input type="checkbox" data-remove="' + esc(f.ext) + '"> Remove ' +
          esc(basename(stem) + "." + f.ext) + ' <span class="muted small">' + human(f.size) + "</span></label>";
      }).join("");
      $("current-files").hidden = false;
      if (q.clips && q.clips.length) {
        $("current-clips").innerHTML = "<b>Uploaded clips</b>" + q.clips.sort(function (a, b) { return a.slide - b.slide; }).map(function (c, i) {
          return '<div class="clip-row"><span class="clip-name">' + esc(c.name.replace(/^\d+-/, "")) + ' <span class="muted small">' + human(c.size) + "</span></span>" +
            '<label class="clip-slide">Slide <input type="number" min="1" data-clip-move="' + i + '" value="' + c.slide + '"></label>' +
            '<label class="check"><input type="checkbox" data-clip-remove="' + i + '"> Remove</label></div>';
        }).join("");
        $("current-clips").hidden = false;
      }
      $("drop-title").textContent = "Replace or add files (optional)";
      $("drop-hint").textContent = "A new PDF replaces the current PDF, a new PPTX replaces the current PPTX. The page address stays the same.";
      $("submit").textContent = "Save changes";
      $("delete").hidden = false;
      $("tab-new").textContent = "Editing";
      showTab("new");
      $("quiz-form").scrollIntoView({ behavior: "smooth", block: "start" });
    }).catch(function (err) { alert("Couldn’t open that quiz: " + err.message); });
  }

  // ---- sign in -------------------------------------------------------------
  function showSignin(msg) {
    $("signin").hidden = false;
    $("uploader").hidden = true;
    if (msg) alert(msg);
  }
  var NO_WRITE = "This GitHub token can read the repository but not save to it. On GitHub open Settings → Developer settings → Fine-grained tokens → your token → Edit, set Repository access to include " + REPO.split("/")[1] + " and Repository permissions → Contents to Read and write, then click Update and try again.";

  function connect() {
    return request("GET", "/repos/" + REPO).then(function (repo) {
      if (!repo.permissions || !repo.permissions.push) throw new Error(NO_WRITE);
      // A public repo is readable by any token, so check that this one can actually write
      // (an unused blob is harmless and cleaned up by GitHub).
      return request("POST", "/repos/" + REPO + "/git/blobs", { content: "qm-write-check", encoding: "utf-8" })
        .catch(function (err) { if (err.status === 403 || err.status === 404) throw new Error(NO_WRITE); throw err; });
    }).then(function () {
      return request("GET", "/user").catch(function () { return null; }).then(function (user) {
        $("who").textContent = "Connected" + (user && user.login ? " as " + user.login : "") + " · saving to " + REPO + " (" + BRANCH + ")";
        $("signin").hidden = true;
        $("uploader").hidden = false;
        return loadRepo();
      });
    }).then(function () {
      var want = new URLSearchParams(location.search).get("quiz");
      if (!want) return;
      var stem = Object.keys(quizzes).filter(function (s) { return slugOf(s) === want; })[0];
      if (stem) startEdit(stem); else showTab("manage");
    });
  }
  $("token-form").addEventListener("submit", function (e) {
    e.preventDefault();
    token = $("token").value.trim();
    connect().then(function () {
      try { localStorage.setItem(KEY, token); } catch (err) { /* session only */ }
    }).catch(function (err) {
      token = "";
      alert(err.status === 401 ? "That token was not accepted by GitHub. Check you copied all of it." :
            err.status === 404 ? "This token can’t see " + REPO + ". Under Repository access, select that repository." : err.message);
    });
  });
  $("signout").addEventListener("click", function () {
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    token = "";
    $("token").value = "";
    showSignin();
  });

  // ---- files ---------------------------------------------------------------
  var files = [];
  function setFiles(fl) {
    files = Array.prototype.slice.call(fl);
    $("file-list").innerHTML = "";
    files.forEach(function (f) {
      var li = document.createElement("span");
      li.textContent = f.name + " · " + human(f.size) + (f.size > MAX ? " — too big (max 300 MB)" : "");
      if (f.size > MAX) li.className = "bad";
      $("file-list").appendChild(li);
    });
    if (files.length && !editing && !$("title").value) {
      $("title").value = files[0].name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
    }
  }
  $("files").addEventListener("change", function () { setFiles($("files").files); });
  var drop = $("drop");
  ["dragenter", "dragover"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add("is-over"); }); });
  ["dragleave", "drop"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove("is-over"); }); });
  drop.addEventListener("drop", function (e) {
    if (e.dataTransfer && e.dataTransfer.files.length) {
      $("files").files = e.dataTransfer.files;
      setFiles(e.dataTransfer.files);
    }
  });

  // ---- committing ----------------------------------------------------------
  function progress(frac, text) {
    $("progress").hidden = false;
    $("bar").style.width = Math.round(frac * 100) + "%";
    if (text) $("progress-text").innerHTML = text;
  }

  function commitTree(entries, message) {
    // Retries if something else was pushed in between (non-fast-forward).
    var attempt = function (n) {
      var head;
      return request("GET", "/repos/" + REPO + "/git/ref/heads/" + BRANCH).then(function (ref) {
        head = ref.object.sha;
        return request("GET", "/repos/" + REPO + "/git/commits/" + head);
      }).then(function (commit) {
        return request("POST", "/repos/" + REPO + "/git/trees", { base_tree: commit.tree.sha, tree: entries });
      }).then(function (tree) {
        return request("POST", "/repos/" + REPO + "/git/commits", { message: message, tree: tree.sha, parents: [head] });
      }).then(function (commit) {
        return request("PATCH", "/repos/" + REPO + "/git/refs/heads/" + BRANCH, { sha: commit.sha })
          .then(function () { return commit.sha; });
      }).catch(function (err) {
        if (n < 4 && (err.status === 422 || err.status === 409)) {
          return new Promise(function (r) { setTimeout(r, 1500 * n); }).then(function () { return attempt(n + 1); });
        }
        throw err;
      });
    };
    return attempt(1);
  }

  // Uploads the chosen files. Files over CHUNK are stored as "name.pptx.part01",
  // "part02"… (the site build joins them back). Old copies of the same file
  // type in `existing` are removed so a quiz never has two versions.
  function uploadBlobs(entries, pathFor, existing, extra) {
    var list = files.map(function (f) { return { file: f, path: pathFor(f) }; }).concat(extra || []);
    var total = list.reduce(function (s, x) { return s + x.file.size; }, 0) || 1, done = 0, written = [];
    var jobs = [];
    list.forEach(function (x) {
      var f = x.file, base = x.path, n = Math.ceil(f.size / CHUNK);
      if (n <= 1) jobs.push({ file: f, blob: f, path: base, label: f.name });
      else for (var i = 0; i < n; i++) {
        jobs.push({ file: f, blob: f.slice(i * CHUNK, (i + 1) * CHUNK), path: base + ".part" + String(i + 1).padStart(2, "0"),
                    label: f.name + " (part " + (i + 1) + " of " + n + ")" });
      }
    });
    return jobs.reduce(function (p, job) {
      return p.then(function () {
        progress(done / total * 0.85, "Uploading " + esc(job.label) + "…");
        return readBase64(job.blob).then(function (b64) {
          return request("POST", "/repos/" + REPO + "/git/blobs", { content: b64, encoding: "base64" }, function (frac) {
            progress((done + frac * job.blob.size) / total * 0.85);
          });
        }).then(function (blob) {
          done += job.blob.size;
          written.push(job.path);
          entries.push({ path: job.path, mode: "100644", type: "blob", sha: blob.sha });
        });
      });
    }, Promise.resolve()).then(function () {
      var exts = files.map(function (f) { return ext(f.name); });
      ((existing && existing.files) || []).forEach(function (f) {
        if (exts.indexOf(f.ext) === -1) return;
        f.paths.forEach(function (path) {
          if (written.indexOf(path) === -1) entries.push({ path: path, mode: "100644", type: "blob", sha: null });
        });
      });
    });
  }

  function watchDeploy(sha, url, doneText) {
    var actions = "https://github.com/" + REPO + "/actions";
    var live = '<a href="' + url + '">' + url + "</a>";
    var tries = 0;
    (function poll() {
      request("GET", "/repos/" + REPO + "/actions/runs?head_sha=" + sha).then(function (res) {
        var run = res.workflow_runs && res.workflow_runs[0];
        if (run && run.status === "completed") {
          if (run.conclusion === "success") { progress(1, "✅ <b>Live!</b> " + doneText + " " + live); loadRepo(); }
          else progress(1, "⚠️ Publishing failed. <a href=\"" + run.html_url + "\" target=\"_blank\" rel=\"noopener\">See what went wrong</a>.");
          return;
        }
        progress(0.9 + Math.min(tries, 20) * 0.004, "Saved ✔ — republishing the site" + (run ? " (" + run.status.replace("_", " ") + ")" : "") + "… usually 1–3 minutes. " + live);
        if (++tries < 90) setTimeout(poll, 8000);
      }).catch(function () {
        progress(1, "Saved ✔ — the site is republishing and changes appear in 1–3 minutes at " + live +
          '. <a href="' + actions + '" target="_blank" rel="noopener">Watch progress on GitHub</a>.');
      });
    })();
  }

  function run(task) {
    var submit = $("submit"), del = $("delete");
    submit.disabled = del.disabled = true;
    return task().catch(function (err) {
      if (err.message === "cancelled") { $("progress").hidden = true; return; }
      if (err.status === 401) return showSignin("Your GitHub token has expired or was revoked. Please connect again.");
      if (err.status === 403 && /not accessible/i.test(err.message)) { progress(0, "❌ " + esc(NO_WRITE)); return; }
      progress(0, "❌ Failed: " + esc(err.message));
    }).then(function () { submit.disabled = del.disabled = false; });
  }

  // "12: https://youtu.be/…" lines <-> [{slide: 12, url: "…"}]
  function textToMedia(text) {
    return text.split(/\n+/).map(function (line) {
      var m = /^\s*(?:slide\s*)?(\d+)\s*[:\-–.)]?\s*(https?:\/\/\S+)/i.exec(line);
      return m ? { slide: parseInt(m[1], 10), url: m[2] } : null;
    }).filter(Boolean);
  }
  function mediaToText(v) {
    if (!v) return "";
    return (Array.isArray(v) ? v : [v]).map(function (e) {
      if (typeof e === "string") return e;
      return e && e.slide && e.url ? e.slide + ": " + e.url : "";
    }).filter(Boolean).join("\n");
  }

  // ---- uploaded audio / video clips ---------------------------------------
  var CLIP_EXT = ["mp4", "m4v", "mov", "webm", "ogv", "mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac",
                  "wmv", "avi", "mpg", "mpeg", "mkv", "3gp", "wma", "aif", "aiff"];
  var newClips = [];   // [{file, slide}]
  function clipName(file) {
    var e = ext(file.name);
    var base = file.name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9._ -]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "clip";
    return base + "." + e;
  }
  function renderClips() {
    $("clip-list").innerHTML = newClips.map(function (c, i) {
      return '<div class="clip-row"><span class="clip-name">' + esc(c.file.name) + ' <span class="muted small">' + human(c.file.size) +
        (c.file.size > MAX ? " — too big (max 300 MB)" : "") + '</span></span>' +
        '<label class="clip-slide">Slide <input type="number" min="1" inputmode="numeric" data-clip-slide="' + i + '" value="' + (c.slide || "") + '" required></label>' +
        '<button class="btn btn-sm" type="button" data-clip-drop="' + i + '" aria-label="Remove">✕</button></div>';
    }).join("");
  }
  $("clip-files").addEventListener("change", function () {
    Array.prototype.forEach.call($("clip-files").files, function (f) {
      if (CLIP_EXT.indexOf(ext(f.name)) === -1) return alert(f.name + " isn’t an audio or video file.");
      var m = /(?:^|\D)(\d{1,3})(?:\D|$)/.exec(f.name);   // "slide 12.mp4" → 12
      newClips.push({ file: f, slide: m ? parseInt(m[1], 10) : "" });
    });
    $("clip-files").value = "";
    renderClips();
  });
  $("clip-list").addEventListener("input", function (e) {
    var i = e.target.dataset.clipSlide;
    if (i !== undefined) newClips[i].slide = parseInt(e.target.value, 10) || "";
  });
  $("clip-list").addEventListener("click", function (e) {
    var i = e.target.dataset.clipDrop;
    if (i !== undefined) { newClips.splice(+i, 1); renderClips(); }
  });
  function checkClips() {
    for (var i = 0; i < newClips.length; i++) {
      var c = newClips[i];
      if (!(c.slide >= 1)) { alert("Enter the slide number for " + c.file.name + "."); return false; }
      if (c.file.size > MAX) { alert(c.file.name + " is larger than 300 MB. Please compress it first."); return false; }
    }
    return true;
  }
  function clipUploads(stem) {
    return newClips.map(function (c) {
      return { file: c.file, path: "quizzes/" + stem + ".media/" + c.slide + "-" + clipName(c.file) };
    });
  }
  // Existing clips: remove, or move to another slide (a rename — no re-upload).
  function clipChanges(q, entries) {
    var changed = 0;
    (q.clips || []).forEach(function (c, i) {
      var remove = document.querySelector('[data-clip-remove="' + i + '"]');
      var slideInput = document.querySelector('[data-clip-move="' + i + '"]');
      var slide = slideInput ? parseInt(slideInput.value, 10) : c.slide;
      if (remove && remove.checked) {
        c.parts.forEach(function (pt) { entries.push({ path: pt.path, mode: "100644", type: "blob", sha: null }); });
        changed++;
      } else if (slide >= 1 && slide !== c.slide) {
        var newName = c.name.replace(/^\d+-/, slide + "-");
        c.parts.forEach(function (pt) {
          entries.push({ path: pt.path.replace("/" + c.name, "/" + newName), mode: "100644", type: "blob", sha: pt.sha });
          entries.push({ path: pt.path, mode: "100644", type: "blob", sha: null });
        });
        changed++;
      }
    });
    return changed;
  }

  function formFields() {
    return {
      title: $("title").value.trim(),
      description: $("description").value.trim(),
      date: $("date").value,
      event: $("event").value.trim(),
      quizmaster: list($("quizmaster").value),
      tags: list($("tags").value),
      media: textToMedia($("media").value)
    };
  }

  function checkFiles() {
    var bad = files.filter(function (f) { return f.size > MAX; });
    if (bad.length) { alert(bad[0].name + " is larger than 300 MB. Export a smaller (compressed) PDF and try again."); return false; }
    var exts = files.map(function (f) { return ext(f.name); });
    if (new Set(exts).size !== exts.length) { alert("Choose at most one file of each type (e.g. one PDF and one PPTX of the same quiz)."); return false; }
    var wrong = exts.filter(function (e) { return DOC_EXT.indexOf(e) === -1; });
    if (wrong.length) { alert("." + wrong[0] + " files aren’t supported. Use PDF or PPTX."); return false; }
    return true;
  }

  $("quiz-form").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!checkFiles() || !checkClips()) return;
    var fields = formFields();
    if (editing) return run(saveEdit.bind(null, fields));
    if (!files.length) return alert("Choose at least one file.");
    run(function () {
      var name = safeName(fields.title), entries = [];
      if (quizzes[name] && !confirm("A quiz named “" + name + "” already exists. Replace it with these files?")) {
        return Promise.reject(new Error("cancelled"));
      }
      progress(0.01, "Starting…");
      return uploadBlobs(entries, function (f) { return "quizzes/" + name + "." + ext(f.name); }, quizzes[name], clipUploads(name)).then(function () {
        return request("POST", "/repos/" + REPO + "/git/blobs", { content: utf8Base64(buildYaml(null, fields)), encoding: "base64" });
      }).then(function (blob) {
        entries.push({ path: "quizzes/" + name + ".yml", mode: "100644", type: "blob", sha: blob.sha });
        progress(0.88, "Saving…");
        return commitTree(entries, "Add quiz: " + fields.title);
      }).then(function (sha) {
        resetForm();
        watchDeploy(sha, pageUrl(name), "Your quiz is published at");
        return loadRepo();
      });
    });
  });

  function saveEdit(fields) {
    var ed = editing, q = quizzes[ed.stem], entries = [];
    var removed = Array.prototype.map.call(document.querySelectorAll("[data-remove]:checked"), function (c) { return c.dataset.remove; });
    var newExts = files.map(function (f) { return ext(f.name); });
    var remaining = q.files.filter(function (f) { return removed.indexOf(f.ext) === -1 || newExts.indexOf(f.ext) !== -1; });
    if (!remaining.length && !files.length) { alert("A quiz needs at least one file. To remove the whole quiz, use “Delete this quiz”."); return Promise.resolve(); }
    var yml = buildYaml(ed.parsed, fields);
    var clipEdits = clipChanges(q, entries);
    if (yml === ed.text && !files.length && !removed.length && !newClips.length && !clipEdits) { alert("Nothing has changed."); return Promise.resolve(); }
    progress(0.01, "Starting…");
    q.files.forEach(function (f) {
      if (removed.indexOf(f.ext) === -1 || newExts.indexOf(f.ext) !== -1) return;
      f.paths.forEach(function (path) { entries.push({ path: path, mode: "100644", type: "blob", sha: null }); });
    });
    return uploadBlobs(entries, function (f) { return "quizzes/" + ed.stem + "." + ext(f.name); }, q, clipUploads(ed.stem)).then(function () {
      if (yml === ed.text) return null;
      return request("POST", "/repos/" + REPO + "/git/blobs", { content: utf8Base64(yml), encoding: "base64" });
    }).then(function (blob) {
      if (blob) entries.push({ path: q.yml ? q.yml.path : "quizzes/" + ed.stem + ".yml", mode: "100644", type: "blob", sha: blob.sha });
      progress(0.88, "Saving…");
      return commitTree(entries, "Update quiz: " + fields.title);
    }).then(function (sha) {
      var url = pageUrl(ed.stem);
      resetForm();
      watchDeploy(sha, url, "Your changes are published at");
      return loadRepo();
    });
  }

  $("delete").addEventListener("click", function () {
    var ed = editing;
    if (!ed) return;
    var q = quizzes[ed.stem], title = $("title").value || basename(ed.stem);
    if (!confirm("Delete “" + title + "” from the website? Its page and downloads will disappear.\n\n(It can still be recovered from the GitHub history.)")) return;
    run(function () {
      var entries = [];
      q.files.forEach(function (f) {
        f.paths.forEach(function (path) { entries.push({ path: path, mode: "100644", type: "blob", sha: null }); });
      });
      if (q.yml) entries.push({ path: q.yml.path, mode: "100644", type: "blob", sha: null });
      (q.clips || []).forEach(function (c) {
        c.parts.forEach(function (pt) { entries.push({ path: pt.path, mode: "100644", type: "blob", sha: null }); });
      });
      progress(0.5, "Deleting…");
      return commitTree(entries, "Delete quiz: " + title).then(function (sha) {
        resetForm();
        showTab("manage");
        watchDeploy(sha, location.origin + BASE, "The quiz has been removed from");
        return loadRepo();
      });
    });
  });

  // ---- About-page photos (pages/gallery.json + pages/gallery/*.jpg) ------------
  var photos = [];        // [{file?, caption, main, thumb, blob?}] in display order
  var photosSaved = "";   // JSON of the saved state, to spot unsaved changes
  var PHOTO_MAX = 2000;   // longest side after resizing in the browser
  var PHOTO_RE = /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i;
  // "Winners - XYZ Quiz 2025.jpg" -> caption; camera names like IMG_2031.jpg -> "" (same rule as build.py)
  function captionFromName(name) {
    var stem = name.replace(/\.[^.]+$/, "");
    if (/^(img|dsc|dscn|pxl|mvimg|photo|image|screenshot|whatsapp image|signal)[\W_]|^[\d\W_]+$/i.test(stem)) return "";
    return stem.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  }

  function photoState() {
    return JSON.stringify(photos.map(function (p) { return [p.file || p.thumb, p.caption, !!p.main]; }));
  }
  function loadPhotos() {
    var load = galleryRepo.json
      ? request("GET", "/repos/" + REPO + "/git/blobs/" + galleryRepo.json).then(function (b) { return JSON.parse(base64Utf8(b.content)).photos || []; })
      : Promise.resolve([]);
    var thumbs = fetch(BASE + "gallery.json?t=" + Date.now()).then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
    return Promise.all([load, thumbs]).then(function (res) {
      var byFile = {};
      res[1].forEach(function (t) { byFile[t.file] = t.thumb; });
      var listed = {};
      photos = res[0].filter(function (e) { return e && galleryRepo.files[e.file]; }).map(function (e) {
        listed[e.file] = true;
        return { file: e.file, caption: e.caption || "", main: !!e.main, thumb: byFile[e.file] || "" };
      });
      // Photos uploaded straight into pages/gallery/ on GitHub (the site shows them too).
      Object.keys(galleryRepo.files).sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); }).forEach(function (f) {
        if (listed[f] || !PHOTO_RE.test(f)) return;
        photos.push({ file: f, caption: captionFromName(f), main: false, thumb: byFile[f] || "" });
      });
      if (photos.length && !photos.some(function (p) { return p.main; })) photos[0].main = true;
      photosSaved = photoState();
      renderPhotos();
    }).catch(function (err) {
      $("photo-list").innerHTML = '<li class="muted">Couldn’t load the photos: ' + esc(err.message) + "</li>";
    });
  }
  function renderPhotos() {
    $("photo-count").textContent = photos.length || "";
    $("photo-list").innerHTML = photos.map(function (p, i) {
      return '<li class="photo-row' + (p.main ? " is-main" : "") + '">' +
        (p.thumb ? '<img src="' + esc(p.thumb) + '" alt="">' : '<span class="manage-ph">publishing</span>') +
        '<div class="photo-fields"><label class="sr-only" for="cap-' + i + '">Caption</label>' +
        '<textarea id="cap-' + i + '" rows="2" data-photo-cap="' + i + '" placeholder="Caption — e.g. Winners, XYZ Quiz 2025, Mumbai">' + esc(p.caption) + "</textarea>" +
        '<div class="photo-actions"><label class="check"><input type="radio" name="photo-main" data-photo-main="' + i + '"' + (p.main ? " checked" : "") + "> Main photo</label>" +
        '<button class="btn btn-sm" type="button" data-photo-move="' + i + ':-1"' + (i ? "" : " disabled") + ' aria-label="Move up">↑</button>' +
        '<button class="btn btn-sm" type="button" data-photo-move="' + i + ':1"' + (i < photos.length - 1 ? "" : " disabled") + ' aria-label="Move down">↓</button>' +
        '<button class="btn btn-sm" type="button" data-photo-remove="' + i + '">Remove</button></div></div></li>';
    }).join("") || '<li class="muted">No photos yet — add some above.</li>';
  }
  $("photo-list").addEventListener("input", function (e) {
    var i = e.target.dataset.photoCap;
    if (i !== undefined) photos[+i].caption = e.target.value;
  });
  $("photo-list").addEventListener("change", function (e) {
    var i = e.target.dataset.photoMain;
    if (i === undefined) return;
    photos.forEach(function (p, j) { p.main = j === +i; });
    renderPhotos();
  });
  $("photo-list").addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.photoMove) {
      var m = b.dataset.photoMove.split(":"), i = +m[0], j = i + +m[1];
      var t = photos[i]; photos[i] = photos[j]; photos[j] = t;
    } else if (b.dataset.photoRemove !== undefined) {
      var gone = photos.splice(+b.dataset.photoRemove, 1)[0];
      if (gone.main && photos.length) photos[0].main = true;
    } else return;
    renderPhotos();
  });

  // Shrinks a phone photo (often 5–10 MB) to a sharp ~2000 px JPEG before upload.
  function resizePhoto(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var k = Math.min(1, PHOTO_MAX / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * k);
        c.height = Math.round(img.naturalHeight * k);
        var g = c.getContext("2d");
        g.imageSmoothingQuality = "high";
        g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error("Couldn’t process " + file.name)); }, "image/jpeg", 0.88);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error(file.name + " couldn’t be opened. If it’s an iPhone HEIC photo, share it as JPG (or take a screenshot) and try again."));
      };
      img.src = url;
    });
  }
  function addPhotos(list) {
    var chosen = Array.prototype.filter.call(list, function (f) { return /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|heic)$/i.test(f.name); });
    return chosen.reduce(function (p, f) {
      return p.then(function () {
        return resizePhoto(f).then(function (blob) {
          photos.push({ caption: captionFromName(f.name), main: !photos.length, blob: blob, name: f.name, thumb: URL.createObjectURL(blob) });
          renderPhotos();
        }).catch(function (err) { alert(err.message); });
      });
    }, Promise.resolve()).then(function () { $("photo-files").value = ""; });
  }
  $("photo-files").addEventListener("change", function () { addPhotos($("photo-files").files); });
  var pdrop = $("photo-drop");
  ["dragenter", "dragover"].forEach(function (t) { pdrop.addEventListener(t, function (e) { e.preventDefault(); pdrop.classList.add("is-over"); }); });
  ["dragleave", "drop"].forEach(function (t) { pdrop.addEventListener(t, function (e) { e.preventDefault(); pdrop.classList.remove("is-over"); }); });
  pdrop.addEventListener("drop", function (e) { if (e.dataTransfer && e.dataTransfer.files.length) addPhotos(e.dataTransfer.files); });

  function photoFileName(p, taken) {
    var base = slugify((p.caption || p.name || "photo").replace(/\.[^.]+$/, "")).slice(0, 60).replace(/-+$/, "") || "photo";
    var name = base + ".jpg", n = 2;
    while (taken[name]) name = base + "-" + n++ + ".jpg";
    taken[name] = true;
    return name;
  }
  $("photos-save").addEventListener("click", function () {
    var fresh = photos.filter(function (p) { return p.blob; });
    if (!fresh.length && photoState() === photosSaved) return alert("Nothing has changed.");
    if (photos.some(function (p) { return !p.caption.trim(); }) &&
        !confirm("Some photos have no caption. Save anyway?")) return;
    var btn = $("photos-save");
    btn.disabled = true;
    var entries = [], taken = {};
    Object.keys(galleryRepo.files).forEach(function (f) { taken[f] = true; });
    var total = fresh.reduce(function (s, p) { return s + p.blob.size; }, 0) || 1, done = 0;
    progress(0.01, "Starting…");
    fresh.reduce(function (chain, p) {
      return chain.then(function () {
        var name = photoFileName(p, taken);
        progress(done / total * 0.85, "Uploading " + esc(p.name || name) + "…");
        return readBase64(p.blob).then(function (b64) {
          return request("POST", "/repos/" + REPO + "/git/blobs", { content: b64, encoding: "base64" }, function (frac) {
            progress((done + frac * p.blob.size) / total * 0.85);
          });
        }).then(function (blob) {
          done += p.blob.size;
          p.file = name;
          entries.push({ path: "pages/gallery/" + name, mode: "100644", type: "blob", sha: blob.sha });
        });
      });
    }, Promise.resolve()).then(function () {
      var keep = {};
      photos.forEach(function (p) { keep[p.file] = true; });
      Object.keys(galleryRepo.files).forEach(function (f) {
        if (!keep[f]) entries.push({ path: "pages/gallery/" + f, mode: "100644", type: "blob", sha: null });
      });
      var json = JSON.stringify({ photos: photos.map(function (p) {
        var o = { file: p.file, caption: p.caption.trim() };
        if (p.main) o.main = true;
        return o;
      }) }, null, 1) + "\n";
      return request("POST", "/repos/" + REPO + "/git/blobs", { content: utf8Base64(json), encoding: "base64" });
    }).then(function (blob) {
      entries.push({ path: "pages/gallery.json", mode: "100644", type: "blob", sha: blob.sha });
      progress(0.88, "Saving…");
      return commitTree(entries, "Update About photos");
    }).then(function (sha) {
      photos.forEach(function (p) { delete p.blob; });
      photosSaved = photoState();
      watchDeploy(sha, location.origin + BASE + "about/", "Your photos are on");
      return loadRepo();
    }).catch(function (err) {
      if (err.status === 401) return showSignin("Your GitHub token has expired or was revoked. Please connect again.");
      progress(0, "❌ Failed: " + esc(err.status === 403 && /not accessible/i.test(err.message) ? NO_WRITE : err.message));
    }).then(function () { btn.disabled = false; });
  });
  window.addEventListener("beforeunload", function (e) {
    if (photos.some(function (p) { return p.blob; }) || (photosSaved && photoState() !== photosSaved)) { e.preventDefault(); e.returnValue = ""; }
  });

  // ---- start ---------------------------------------------------------------
  $("date").value = today();
  if (!REPO) { showSignin(); return alert("github_repo is not set in site.yml."); }
  if (token) connect().catch(function (err) { showSignin(err && err.message === NO_WRITE ? NO_WRITE : undefined); });
  else showSignin();
})();
