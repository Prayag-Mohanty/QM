/* Upload page: commits quiz files straight to the GitHub repo with the owner's
   token (Git Data API), which triggers the site rebuild. No server needed. */
(function () {
  "use strict";
  var root = document.getElementById("upload");
  if (!root) return;

  var API = "https://api.github.com";
  var REPO = root.dataset.repo;
  var BRANCH = root.dataset.branch || "main";
  var BASE = root.dataset.base || "/";
  var KEY = "qm-upload-token";
  var MAX = 100 * 1024 * 1024; // GitHub's per-file limit

  var $ = function (id) { return document.getElementById(id); };
  var token = "";
  try { token = localStorage.getItem(KEY) || ""; } catch (e) { /* storage blocked */ }

  function request(method, path, body, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
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
  function human(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.ceil(n / 1024) + " KB"; }
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
  function yamlValue(v) { return JSON.stringify(v); } // JSON strings/arrays are valid YAML

  // ---- sign in -------------------------------------------------------------
  function showSignin(msg) {
    $("signin").hidden = false;
    $("uploader").hidden = true;
    if (msg) alert(msg);
  }
  function connect() {
    return request("GET", "/repos/" + REPO).then(function (repo) {
      if (!repo.permissions || !repo.permissions.push) throw new Error("This token can read but not write to " + REPO + ". Give it Contents: Read and write.");
      return request("GET", "/user").catch(function () { return null; }).then(function (user) {
        $("who").textContent = "Connected" + (user && user.login ? " as " + user.login : "") + " · saving to " + REPO + " (" + BRANCH + ")";
        $("signin").hidden = true;
        $("uploader").hidden = false;
      });
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

  // ---- form ----------------------------------------------------------------
  var files = [];
  function setFiles(list) {
    files = Array.prototype.slice.call(list);
    $("file-list").innerHTML = "";
    files.forEach(function (f) {
      var li = document.createElement("span");
      li.textContent = f.name + " · " + human(f.size) + (f.size > MAX ? " — too big (max 100 MB)" : "");
      if (f.size > MAX) li.className = "bad";
      $("file-list").appendChild(li);
    });
    if (files.length && !$("title").value) {
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
  $("date").value = new Date().toISOString().slice(0, 10);

  function progress(frac, text) {
    $("progress").hidden = false;
    $("bar").style.width = Math.round(frac * 100) + "%";
    if (text) $("progress-text").innerHTML = text;
  }

  function exists(path) {
    var enc = path.split("/").map(encodeURIComponent).join("/");
    return request("GET", "/repos/" + REPO + "/contents/" + enc + "?ref=" + encodeURIComponent(BRANCH))
      .then(function () { return true; }, function (e) { if (e.status === 404) return false; throw e; });
  }

  function commitTree(entries, message) {
    // Retries if someone else pushed in between (non-fast-forward).
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
        if (n < 3 && (err.status === 422 || err.status === 409)) return attempt(n + 1);
        throw err;
      });
    };
    return attempt(1);
  }

  function watchDeploy(sha, pageUrl) {
    var actions = "https://github.com/" + REPO + "/actions";
    var live = '<a href="' + pageUrl + '">' + pageUrl + "</a>";
    var tries = 0;
    (function poll() {
      request("GET", "/repos/" + REPO + "/actions/runs?head_sha=" + sha).then(function (res) {
        var run = res.workflow_runs && res.workflow_runs[0];
        if (run && run.status === "completed") {
          if (run.conclusion === "success") progress(1, "✅ <b>Live!</b> Your quiz is published at " + live);
          else progress(1, "⚠️ Publishing failed. <a href=\"" + run.html_url + "\" target=\"_blank\" rel=\"noopener\">See what went wrong</a>.");
          return;
        }
        progress(0.9 + Math.min(tries, 20) * 0.004, "Saved ✔ — building and publishing the site" + (run ? " (" + run.status.replace("_", " ") + ")" : "") + "… usually 1–3 minutes. Your quiz will appear at " + live);
        if (++tries < 90) setTimeout(poll, 8000);
      }).catch(function () {
        progress(1, "Saved ✔ — the site is republishing and your quiz will appear in 1–3 minutes at " + live +
          '. <a href="' + actions + '" target="_blank" rel="noopener">Watch progress on GitHub</a>.');
      });
    })();
  }

  $("quiz-form").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!files.length) return alert("Choose at least one file.");
    var bad = files.filter(function (f) { return f.size > MAX; });
    if (bad.length) return alert(bad[0].name + " is larger than GitHub's 100 MB limit. Export a smaller (compressed) PDF and try again.");
    var exts = files.map(function (f) { return ext(f.name); });
    if (new Set(exts).size !== exts.length) return alert("Choose at most one file of each type (e.g. one PDF and one PPTX of the same quiz).");

    var title = $("title").value.trim();
    var name = safeName(title);
    var desc = $("description").value.trim();
    var tags = $("tags").value.split(",").map(function (t) { return t.trim(); }).filter(Boolean);
    var yml = "title: " + yamlValue(title) + "\n" +
      (desc ? "description: " + yamlValue(desc) + "\n" : "") +
      ($("date").value ? "date: " + $("date").value + "\n" : "") +
      (tags.length ? "tags: " + yamlValue(tags) + "\n" : "") +
      ($("event").value.trim() ? "event: " + yamlValue($("event").value.trim()) + "\n" : "");
    var paths = files.map(function (f) { return "quizzes/" + name + "." + ext(f.name); });
    var pageUrl = location.origin + BASE + "quiz/" + slugify(name) + "/";
    var submit = $("submit");
    submit.disabled = true;
    progress(0.01, "Checking…");

    Promise.all(paths.map(exists)).then(function (found) {
      if (found.some(Boolean) && !confirm("A quiz named “" + name + "” already exists. Replace it with these files?")) {
        throw new Error("cancelled");
      }
      var total = files.reduce(function (s, f) { return s + f.size; }, 0) || 1, done = 0;
      var entries = [];
      return files.reduce(function (p, f, i) {
        return p.then(function () {
          progress(done / total * 0.85, "Uploading " + f.name + "…");
          return readBase64(f).then(function (b64) {
            return request("POST", "/repos/" + REPO + "/git/blobs", { content: b64, encoding: "base64" }, function (frac) {
              progress((done + frac * f.size) / total * 0.85);
            });
          }).then(function (blob) {
            done += f.size;
            entries.push({ path: paths[i], mode: "100644", type: "blob", sha: blob.sha });
          });
        });
      }, Promise.resolve()).then(function () {
        return request("POST", "/repos/" + REPO + "/git/blobs", { content: utf8Base64(yml), encoding: "base64" });
      }).then(function (blob) {
        entries.push({ path: "quizzes/" + name + ".yml", mode: "100644", type: "blob", sha: blob.sha });
        progress(0.88, "Saving…");
        return commitTree(entries, "Add quiz: " + title);
      });
    }).then(function (sha) {
      $("quiz-form").reset();
      $("date").value = new Date().toISOString().slice(0, 10);
      setFiles([]);
      watchDeploy(sha, pageUrl);
    }).catch(function (err) {
      if (err.message === "cancelled") { $("progress").hidden = true; return; }
      if (err.status === 401) return showSignin("Your GitHub token has expired or was revoked. Please connect again.");
      progress(0, "❌ Upload failed: " + err.message.replace(/</g, "&lt;"));
    }).then(function () { submit.disabled = false; });
  });

  // ---- start ---------------------------------------------------------------
  if (!REPO) { showSignin(); return alert("github_repo is not set in site.yml."); }
  if (token) connect().catch(function () { showSignin(); });
  else showSignin();
})();
