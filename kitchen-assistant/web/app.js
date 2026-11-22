// Interface vocale : reconnaissance vocale et synthèse vocale du navigateur,
// le serveur fait le reste (Claude + Google Keep).
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* navigation privée */ } },
  };

  // Jeton passé une fois dans l'adresse (?token=...), puis mémorisé.
  const params = new URLSearchParams(location.search);
  if (params.get("token")) {
    store.set("token", params.get("token"));
    params.delete("token");
    const q = params.toString();
    history.replaceState(null, "", location.pathname + (q ? "?" + q : ""));
  }

  let token = store.get("token", "");
  let assistantName = "Cuistot";
  let wakeWord = store.get("wakeWord", "");
  let handsFree = store.get("handsFree", "0") === "1";
  let voiceName = store.get("voice", "");
  let conversationId = null;
  let mode = "idle"; // idle | armed | listening | thinking | speaking
  let recognition = null;
  let audioCtx = null;
  let wakeLock = null;
  let unlocked = false;
  let knownItems = null;

  // ---------------------------------------------------------------- affichage

  function setMode(next, status) {
    mode = next;
    for (const m of ["armed", "listening", "thinking", "speaking"]) {
      document.body.classList.toggle(m, m === next);
    }
    if (status !== undefined) $("status").textContent = status;
  }

  function addBubble(kind, text) {
    const li = document.createElement("li");
    li.className = kind;
    li.textContent = text;
    const chat = $("chat");
    chat.appendChild(li);
    while (chat.children.length > 6) chat.removeChild(chat.firstChild);
  }

  function renderList(items) {
    const ul = $("items");
    ul.textContent = "";
    for (const text of items) {
      const li = document.createElement("li");
      li.textContent = text;
      if (knownItems && !knownItems.has(text)) li.classList.add("new");
      ul.appendChild(li);
    }
    knownItems = new Set(items);
    $("count").textContent = items.length ? String(items.length) : "";
    $("empty").hidden = items.length > 0;
  }

  // ---------------------------------------------------------------------- API

  async function api(path, options = {}) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    const res = await fetch(path, { ...options, headers });
    if (res.status === 401) throw new Error("auth");
    if (!res.ok) throw new Error("http " + res.status);
    return res.json();
  }

  async function refreshList() {
    try {
      const r = await api("/api/list");
      $("listTitle").textContent = r.title;
      renderList(r.items);
    } catch (e) {
      if (e.message === "auth") $("status").textContent = "Jeton d'accès requis : ouvre les réglages.";
    }
  }

  async function loadConfig() {
    try {
      const c = await api("/api/config");
      assistantName = c.assistant_name;
      $("assistantName").textContent = assistantName;
      document.title = assistantName;
      $("listTitle").textContent = c.list_title;
    } catch { /* affiché par refreshList */ }
    if (!wakeWord) wakeWord = assistantName;
    $("wakeWord").value = wakeWord;
  }

  // -------------------------------------------------------------------- audio

  // iOS n'autorise la synthèse vocale et le son qu'après un premier geste.
  function unlockAudio() {
    if (unlocked) return;
    unlocked = true;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch { audioCtx = null; }
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  }

  function beep(freq = 880, ms = 120) {
    if (!audioCtx) return;
    try {
      if (audioCtx.state === "suspended") audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + ms / 1000);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + ms / 1000);
    } catch { /* pas grave */ }
  }

  function frenchVoices() {
    if (!("speechSynthesis" in window)) return [];
    return speechSynthesis.getVoices().filter((v) => v.lang && v.lang.toLowerCase().startsWith("fr"));
  }

  function pickVoice() {
    const voices = frenchVoices();
    return voices.find((v) => v.name === voiceName)
      || voices.find((v) => v.lang === "fr-FR" && v.localService)
      || voices.find((v) => v.lang === "fr-FR")
      || voices[0] || null;
  }

  function fillVoices() {
    const select = $("voiceSelect");
    const voices = frenchVoices();
    select.textContent = "";
    const current = pickVoice();
    for (const v of voices) {
      const opt = document.createElement("option");
      opt.value = v.name;
      opt.textContent = `${v.name} (${v.lang})`;
      if (current && v.name === current.name) opt.selected = true;
      select.appendChild(opt);
    }
    if (!voices.length) {
      const opt = document.createElement("option");
      opt.textContent = "Voix par défaut";
      select.appendChild(opt);
    }
  }

  function speak(text) {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window) || !text) return resolve();
      stopRecognition();
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "fr-FR";
      const voice = pickVoice();
      if (voice) u.voice = voice;
      u.rate = 1.05;
      let done = false;
      // Certains navigateurs n'envoient jamais « end » : filet de sécurité.
      const timer = setTimeout(finish, 2000 + text.length * 90);
      function finish() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      }
      u.onend = finish;
      u.onerror = finish;
      setMode("speaking");
      speechSynthesis.speak(u);
    });
  }

  // ------------------------------------------------------ reconnaissance vocale

  function stopRecognition() {
    const rec = recognition;
    recognition = null;
    if (rec) {
      rec.onend = null;
      rec.onresult = null;
      rec.onerror = null;
      try { rec.abort(); } catch { /* déjà arrêtée */ }
    }
  }

  function micError(ev) {
    if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
      stopRecognition();
      setMode("idle", !window.isSecureContext
        ? "Le micro demande une adresse https (voir le README)."
        : handsFree
          ? "Touche le micro pour activer l'écoute (et autorise le micro)."
          : "Accès au micro refusé : autorise-le dans les réglages du navigateur.");
      return true;
    }
    return false;
  }

  // Écoute une demande (après un appui, le mot d'activation ou une question).
  function listen(followUp = false) {
    if (!SR) {
      setMode("idle", "Pas de reconnaissance vocale ici : écris ta demande.");
      return;
    }
    stopRecognition();
    const rec = new SR();
    rec.lang = "fr-FR";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    let finalText = "";
    let latest = "";

    rec.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      latest = (finalText + " " + interim).trim();
      $("interim").textContent = latest;
    };
    rec.onerror = (ev) => { micError(ev); };
    rec.onend = () => {
      if (recognition !== rec) return;
      recognition = null;
      $("interim").textContent = "";
      const text = (finalText || latest).trim();
      if (text) send(text);
      else goIdle(followUp ? "Pas de réponse, je laisse tomber." : "Je n'ai rien entendu.");
    };

    recognition = rec;
    setMode("listening", followUp ? "Je t'écoute…" : "J'écoute…");
    beep();
    try {
      rec.start();
    } catch {
      recognition = null;
      goIdle("Appuie sur le micro pour parler.");
    }
  }

  function normalize(text) {
    // Caractère par caractère, pour garder les mêmes positions que le texte d'origine.
    return text.split("").map((c) => (c.normalize("NFD")[0] || c).toLowerCase()).join("");
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Position juste après le mot d'activation, ou -1.
  function afterWakeWord(text) {
    const w = normalize(wakeWord.trim());
    if (!w) return -1;
    const base = w.length > 4 ? w.slice(0, -1) : w; // « cuisto », « cuistot », « cuistots »
    const m = new RegExp("(^|[^a-z])" + escapeRegex(base) + "[a-z]*[\\s,.!:;-]*", "i").exec(normalize(text));
    return m ? m.index + m[0].length : -1;
  }

  // Mode mains libres : écoute en continu jusqu'au mot d'activation.
  function startWake() {
    if (!SR || !handsFree) return goIdle();
    stopRecognition();
    const rec = new SR();
    rec.lang = "fr-FR";
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const text = r[0].transcript;
        const pos = afterWakeWord(text);
        if (pos < 0) continue;
        $("interim").textContent = text;
        if (!r.isFinal) continue; // on attend la fin de la phrase
        stopRecognition();
        $("interim").textContent = "";
        const command = text.slice(pos).trim();
        if (command.split(/\s+/).filter(Boolean).length >= 2) {
          beep();
          send(command);
        } else {
          listen(); // juste « Cuistot » : on attend la demande
        }
        return;
      }
    };
    rec.onerror = (ev) => { micError(ev); };
    rec.onend = () => {
      // Le navigateur coupe l'écoute régulièrement : on relance.
      if (recognition === rec && mode === "armed" && handsFree) {
        recognition = null;
        setTimeout(() => { if (mode === "armed" && handsFree && !recognition) startWake(); }, 300);
      }
    };

    recognition = rec;
    setMode("armed", `Dis « ${wakeWord} »…`);
    try { rec.start(); } catch { /* relancé au prochain tour */ }
  }

  function goIdle(status) {
    if (handsFree && SR) {
      startWake();
      if (status) $("status").textContent = status;
      setTimeout(() => { if (mode === "armed") $("status").textContent = `Dis « ${wakeWord} »…`; }, 2500);
    } else {
      setMode("idle", status || "Appuie et parle");
    }
  }

  // ------------------------------------------------------------- conversation

  async function send(text) {
    text = text.trim();
    if (!text) return goIdle();
    stopRecognition();
    addBubble("me", text);
    setMode("thinking", "Je réfléchis…");
    let reply;
    try {
      reply = await api("/api/message", {
        method: "POST",
        body: JSON.stringify({ text, conversation_id: conversationId }),
      });
    } catch (e) {
      const msg = e.message === "auth"
        ? "Jeton d'accès refusé : renseigne-le dans les réglages."
        : "Le serveur ne répond pas.";
      addBubble("bot error", msg);
      return goIdle(msg);
    }
    conversationId = reply.conversation_id;
    addBubble("bot", reply.reply);
    if (reply.list_changed) refreshList();
    $("status").textContent = "";
    await speak(reply.reply);
    if (reply.expects_answer) listen(true);
    else goIdle();
  }

  // ------------------------------------------------------------------ actions

  $("micBtn").addEventListener("click", () => {
    unlockAudio();
    if (mode === "listening") {
      // Deuxième appui : on arrête d'écouter et on envoie ce qui a été entendu.
      try { recognition && recognition.stop(); } catch { /* rien */ }
      return;
    }
    if (mode === "thinking") return;
    if (mode === "speaking") speechSynthesis.cancel();
    listen();
  });

  $("typeForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    unlockAudio();
    const input = $("typeInput");
    const text = input.value;
    input.value = "";
    if (mode !== "thinking") send(text);
  });

  $("settingsBtn").addEventListener("click", () => {
    const panel = $("settings");
    panel.hidden = !panel.hidden;
    $("settingsBtn").setAttribute("aria-expanded", String(!panel.hidden));
  });

  $("handsFree").checked = handsFree;
  $("handsFree").addEventListener("change", (ev) => {
    unlockAudio();
    handsFree = ev.target.checked;
    store.set("handsFree", handsFree ? "1" : "0");
    if (handsFree) {
      keepScreenOn();
      if (mode === "idle") startWake();
    } else {
      releaseScreen();
      if (mode === "armed") { stopRecognition(); goIdle(); }
    }
  });

  $("wakeWord").addEventListener("change", (ev) => {
    wakeWord = ev.target.value.trim() || assistantName;
    ev.target.value = wakeWord;
    store.set("wakeWord", wakeWord);
    if (mode === "armed") startWake();
  });

  $("voiceSelect").addEventListener("change", (ev) => {
    voiceName = ev.target.value;
    store.set("voice", voiceName);
    unlockAudio();
    speak("Voilà ma voix.").then(() => goIdle());
  });

  $("tokenInput").value = token;
  $("tokenInput").addEventListener("change", (ev) => {
    token = ev.target.value.trim();
    store.set("token", token);
    loadConfig().then(refreshList);
  });

  // L'écran reste allumé en mode mains libres (tablette au mur).
  async function keepScreenOn() {
    try {
      if ("wakeLock" in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      }
    } catch { /* refusé ou non pris en charge */ }
  }
  function releaseScreen() {
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    refreshList();
    if (handsFree) {
      keepScreenOn();
      if (mode === "armed" && !recognition) startWake();
    }
  });

  if ("speechSynthesis" in window) {
    fillVoices();
    speechSynthesis.onvoiceschanged = fillVoices;
  }

  if (!window.isSecureContext) {
    setMode("idle", "Ouvre cette page en https pour utiliser le micro (voir le README).");
  } else if (!SR) {
    setMode("idle", "Pas de reconnaissance vocale ici : écris ta demande.");
  }

  loadConfig().then(() => {
    refreshList();
    // En mains libres, on tente d'écouter tout de suite. Si le navigateur exige
    // un geste d'abord, micError() demande de toucher le micro une fois.
    if (handsFree && SR && window.isSecureContext) {
      keepScreenOn();
      startWake();
    }
  });
  setInterval(() => { if (mode === "idle" || mode === "armed") refreshList(); }, 60000);
})();
