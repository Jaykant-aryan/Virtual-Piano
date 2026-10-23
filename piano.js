"use strict";

/*
 * Virtual Piano Studio — unified client-side controls
 * Requires Tone.js to be loaded before this file.
 * Preserves the existing Flask HTML element IDs for piano and song playback.
 */

// ---------- Keyboard and note setup ----------
const keyOrder = "zxcvbnmasdfghjklqwertyuiop1234567890";
const PIANO_MIN_MIDI = 21; // A0 — lowest note on a standard 88-key piano
const PIANO_MAX_MIDI = 108; // C8 — highest note on a standard 88-key piano
const VISIBLE_KEY_COUNT = 36; // Keep visible keys matched to computer-key controls
const RANGE_STEP = 12; // Move by one octave at a time
let visibleStartMidi = PIANO_MIN_MIDI;
const heldComputerNotes = new Map(); // physical key -> exact MIDI note pressed, even if range changes

const audioStatus = document.getElementById("audio-status");
const songStatus = document.getElementById("song-status");
let pianoSampler = null; // currently selected instrument
let acousticSampler = null;
let digitalSynth = null;
let instrumentMode = "acoustic";
let acousticSamplesReady = false;
let samplesReady = false;
let loadingError = false;
let masterVolume = null;
let echoEffect = null;
let reverbEffect = null;
let metronomeSynth = null;
let audioReadyPromise = null;

const heldKeys = new Set();
const manualNotes = new Map(); // source:midi -> midi
const sustainedNotes = new Set();
let sustainEnabled = false;

let songTimers = [];
let songToken = 0;

// Metronome
let metronomeRunning = false;
let metronomeTimer = null;
let metronomeBpm = 100;
let metronomeBeat = 0;

// Performance recorder (records note presses/releases, not microphone input)
let recording = false;
let recordingStartedAt = 0;
let recordedEvents = [];
let recordingTimers = [];
let recordedPlaybackRunning = false;
let recordedPlaybackToken = 0;

function midiToName(midi) {
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    return names[midi % 12] + (Math.floor(midi / 12) - 1);
}

function noteToMidi(note) {
    const match = note.trim().match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
    if (!match) return null;
    const baseNotes = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    let semitone = baseNotes[match[1].toUpperCase()];
    if (match[2] === "#") semitone++;
    if (match[2] === "b") semitone--;
    const midi = (Number(match[3]) + 1) * 12 + semitone;
    return midi >= 0 && midi <= 127 ? midi : null;
}

function setAudioMessage(message) {
    if (audioStatus) audioStatus.textContent = message;
}

// ---------- Audio engine ----------
function initializeAudio() {
    if (typeof Tone === "undefined") {
        loadingError = true;
        setAudioMessage("Tone.js did not load. Check your internet connection and refresh.");
        console.error("Tone.js is not available. Check the Tone.js script in index.html.");
        return;
    }

    setAudioMessage("Loading piano sounds...");

    // Initialize the sampler first so optional effects can never prevent the
    // basic piano sound from being created.
    try {
        acousticSampler = new Tone.Sampler({
            urls: {
                A0: "A0.mp3", C1: "C1.mp3", "D#1": "Ds1.mp3", "F#1": "Fs1.mp3",
                A1: "A1.mp3", C2: "C2.mp3", "D#2": "Ds2.mp3", "F#2": "Fs2.mp3",
                A2: "A2.mp3", C3: "C3.mp3", "D#3": "Ds3.mp3", "F#3": "Fs3.mp3",
                A3: "A3.mp3", C4: "C4.mp3", "D#4": "Ds4.mp3", "F#4": "Fs4.mp3",
                A4: "A4.mp3", C5: "C5.mp3", "D#5": "Ds5.mp3", "F#5": "Fs5.mp3",
                A5: "A5.mp3", C6: "C6.mp3", "D#6": "Ds6.mp3", "F#6": "Fs6.mp3",
                A6: "A6.mp3", C7: "C7.mp3", "D#7": "Ds7.mp3", "F#7": "Fs7.mp3",
                A7: "A7.mp3", C8: "C8.mp3"
            },
            baseUrl: "https://tonejs.github.io/audio/salamander/",
            release: 1,
            onload: () => {
                acousticSamplesReady = true;
                if (instrumentMode === "acoustic") samplesReady = true;
                loadingError = false;
                setAudioMessage("Piano sounds loaded. Click a key to play!");
                console.info("Piano samples loaded successfully.");
            },
            onerror: (error) => {
                loadingError = true;
                setAudioMessage("Piano samples failed to load. Check your connection and refresh.");
                console.error("Piano sample loading error:", error);
            }
        });
    } catch (error) {
        acousticSampler = null;
        pianoSampler = null;
        loadingError = true;
        setAudioMessage("Could not initialize piano audio. Check the browser Console.");
        console.error("Could not initialize Tone.Sampler:", error);
        return;
    }

    // Effects are optional: if an effect cannot be created, route the sampler
    // straight to the speakers so the piano remains playable.
    try {
        masterVolume = new Tone.Volume(-3);
        echoEffect = new Tone.FeedbackDelay({ delayTime: 0.28, feedback: 0.28, wet: 0 });
        reverbEffect = new Tone.Reverb({ decay: 2.4, preDelay: 0.015, wet: 0 });
        echoEffect.connect(reverbEffect);
        reverbEffect.connect(masterVolume);
        masterVolume.toDestination();
        acousticSampler.connect(echoEffect);
        digitalSynth = new Tone.PolySynth(Tone.Synth, {
            oscillator: { type: "triangle" },
            envelope: { attack: 0.008, decay: 0.18, sustain: 0.55, release: 0.45 }
        });
        digitalSynth.connect(echoEffect);
        pianoSampler = acousticSampler;
        console.info("Piano effects and both instrument engines initialized.");
    } catch (error) {
        console.warn("An audio effect failed to initialize; using dry piano audio instead.", error);
        try {
            acousticSampler.toDestination();
            digitalSynth = new Tone.PolySynth(Tone.Synth, { oscillator: { type: "triangle" }, envelope: { attack: 0.008, decay: 0.18, sustain: 0.55, release: 0.45 } }).toDestination();
            pianoSampler = acousticSampler;
        } catch (routingError) {
            console.error("Could not connect piano audio to output:", routingError);
        }
        masterVolume = null;
        echoEffect = null;
        reverbEffect = null;
        try {
            digitalSynth = new Tone.PolySynth(Tone.Synth, {
                oscillator: { type: "triangle" },
                envelope: { attack: 0.008, decay: 0.18, sustain: 0.55, release: 0.45 }
            }).toDestination();
        } catch (synthError) {
            console.error("Could not initialize digital piano sound:", synthError);
        }
    }
    pianoSampler = acousticSampler;
    samplesReady = acousticSamplesReady;
}

function connectInstrument(node) {
    if (!node) return;
    try {
        if (echoEffect) node.connect(echoEffect);
        else node.toDestination();
    } catch (error) {
        console.warn("Could not connect instrument through effects; using direct output.", error);
        try { node.toDestination(); } catch (_) {}
    }
}

function switchInstrument(mode) {
    if (mode !== "acoustic" && mode !== "digital") return;
    if (pianoSampler && samplesReady && typeof pianoSampler.releaseAll === "function") {
        try { pianoSampler.releaseAll(); } catch (_) {}
    }
    instrumentMode = mode;
    manualNotes.clear(); sustainedNotes.clear(); heldKeys.clear();
    document.querySelectorAll("#piano .piano-key.active").forEach(key => key.classList.remove("active"));
    if (mode === "acoustic") {
        pianoSampler = acousticSampler;
        samplesReady = acousticSamplesReady;
        setAudioMessage(samplesReady ? "Acoustic piano ready." : "Loading acoustic piano samples...");
    } else {
        if (!digitalSynth && typeof Tone !== "undefined") {
            try {
                digitalSynth = new Tone.PolySynth(Tone.Synth, {
                    oscillator: { type: "triangle" },
                    envelope: { attack: 0.008, decay: 0.18, sustain: 0.55, release: 0.45 }
                });
                connectInstrument(digitalSynth);
            } catch (error) {
                console.error("Could not initialize digital piano:", error);
                setAudioMessage("Digital piano could not initialize. Check Console.");
                return;
            }
        }
        pianoSampler = digitalSynth;
        samplesReady = Boolean(digitalSynth);
        setAudioMessage("Digital/electronic piano ready. Click a key to play!");
    }
    const label = document.getElementById("instrument-mode-label");
    if (label) label.textContent = mode === "acoustic" ? "Acoustic piano" : "Digital / electronic piano";
}

async function startAudio() {
    if (typeof Tone === "undefined" || !pianoSampler) {
        setAudioMessage("Piano audio is unavailable. Refresh the page.");
        return false;
    }
    try {
        await Tone.start();
    } catch (error) {
        console.error("Could not start audio:", error);
        setAudioMessage("Browser blocked audio. Click the page and try again.");
        return false;
    }
    if (!samplesReady) {
        setAudioMessage(loadingError ? "Piano samples failed to load. Check your connection and refresh." : "Piano sounds are still loading. Please wait a little longer.");
        return false;
    }
    return true;
}

// ---------- Note handling and sustain ----------
function highlightKey(midi, active) {
    const key = document.querySelector(`[data-midi="${midi}"]`);
    if (key) key.classList.toggle("active", active);
}

function heldMidi(midi) {
    return [...manualNotes.values()].includes(midi);
}

function recordEvent(type, midi) {
    if (!recording) return;
    recordedEvents.push({ type, midi, time: Math.max(0, performance.now() - recordingStartedAt) });
    updateRecordingStatus();
}

async function pressNote(midi, source) {
    const id = `${source}:${midi}`;
    if (manualNotes.has(id)) return;
    if (!(await startAudio())) return;
    try {
        // A fresh press of a sustained pitch should not leave the old voice dangling.
        if (sustainedNotes.has(midi)) {
            sustainedNotes.delete(midi);
            if (!heldMidi(midi)) pianoSampler.triggerRelease(midiToName(midi));
        }
        pianoSampler.triggerAttack(midiToName(midi));
        manualNotes.set(id, midi);
        highlightKey(midi, true);
        recordEvent("on", midi);
    } catch (error) {
        console.error("Could not play note:", error);
        setAudioMessage("Could not play this note. Check the browser Console.");
    }
}

function releaseNote(midi, source) {
    const id = `${source}:${midi}`;
    if (!manualNotes.has(id)) return;
    manualNotes.delete(id);
    recordEvent("off", midi);
    if (!heldMidi(midi) && pianoSampler && samplesReady) {
        if (sustainEnabled) sustainedNotes.add(midi);
        else pianoSampler.triggerRelease(midiToName(midi));
        highlightKey(midi, false);
    }
}

function flushSustainedNotes() {
    if (pianoSampler && samplesReady) {
        for (const midi of sustainedNotes) {
            if (!heldMidi(midi)) pianoSampler.triggerRelease(midiToName(midi));
        }
    }
    sustainedNotes.clear();
}

function setSustain(enabled) {
    sustainEnabled = Boolean(enabled);
    const button = document.getElementById("sustain-pedal");
    if (button) {
        button.textContent = sustainEnabled ? "Sustain: ON" : "Sustain: OFF";
        button.setAttribute("aria-pressed", String(sustainEnabled));
        button.classList.toggle("sustain-on", sustainEnabled);
    }
    if (!sustainEnabled) flushSustainedNotes();
}

function releaseAllManualNotes() {
    for (const [id, midi] of [...manualNotes.entries()]) {
        manualNotes.delete(id);
        recordEvent("off", midi);
        if (!heldMidi(midi) && pianoSampler && samplesReady) {
            if (sustainEnabled) sustainedNotes.add(midi);
            else pianoSampler.triggerRelease(midiToName(midi));
            highlightKey(midi, false);
        }
    }
    heldKeys.clear();
    heldComputerNotes.clear();
}

// ---------- Effects and master volume ----------
function setEcho(value) {
    if (!echoEffect) return;
    const amount = Number(value) / 100;
    echoEffect.wet.rampTo(amount, 0.04);
    const label = document.getElementById("echo-value");
    if (label) label.textContent = `${value}%`;
}

function setReverb(value) {
    if (!reverbEffect) return;
    const amount = Number(value) / 100;
    reverbEffect.wet.rampTo(amount, 0.04);
    const label = document.getElementById("reverb-value");
    if (label) label.textContent = `${value}%`;
}

function setEchoTime(value) {
    if (echoEffect) echoEffect.delayTime.rampTo(Number(value) / 1000, 0.04);
    const label = document.getElementById("echo-time-value");
    if (label) label.textContent = `${value} ms`;
}

function setVolume(value) {
    if (masterVolume) masterVolume.volume.rampTo(Number(value), 0.05);
    const label = document.getElementById("master-volume-value");
    if (label) label.textContent = `${value} dB`;
}

// ---------- Metronome ----------
function ensureMetronomeSynth() {
    if (metronomeSynth || typeof Tone === "undefined") return;
    metronomeSynth = new Tone.MembraneSynth({
        pitchDecay: 0.002,
        octaves: 8,
        oscillator: { type: "sine" },
        envelope: { attack: 0.001, decay: 0.045, sustain: 0, release: 0.01 }
    }).toDestination();
    metronomeSynth.volume.value = -7;
}

function metronomeClick() {
    if (!metronomeRunning) return;
    ensureMetronomeSynth();
    if (!metronomeSynth) return;
    metronomeBeat = (metronomeBeat % 4) + 1;
    try {
        // Short, bright click; beat one is higher to mark the start of each bar.
        metronomeSynth.triggerAttackRelease(metronomeBeat === 1 ? "C6" : "G5", "32n");
    } catch (error) { console.error("Metronome click failed:", error); }
    const indicator = document.getElementById("metronome-beat");
    if (indicator) {
        indicator.textContent = String(metronomeBeat);
        indicator.style.background = metronomeBeat === 1 ? "#f2c14e" : "transparent";
        indicator.style.color = metronomeBeat === 1 ? "#222" : "inherit";
        indicator.setAttribute("aria-label", `Beat ${metronomeBeat} of 4`);
    }
}

async function startMetronome() {
    if (metronomeRunning) { stopMetronome(); return; }
    if (typeof Tone === "undefined") {
        const status = document.getElementById("metronome-status");
        if (status) status.textContent = "Tone.js did not load.";
        return;
    }
    try {
        await Tone.start();
        ensureMetronomeSynth();
        metronomeRunning = true;
        metronomeBeat = 0;
        const button = document.getElementById("metronome-toggle");
        if (button) { button.textContent = "■ Stop"; button.setAttribute("aria-pressed", "true"); }
        const status = document.getElementById("metronome-status");
        if (status) status.textContent = `Running at ${metronomeBpm} BPM`;
        metronomeClick();
        metronomeTimer = setInterval(metronomeClick, 60000 / metronomeBpm);
    } catch (error) {
        console.error("Could not start metronome:", error);
        const status = document.getElementById("metronome-status");
        if (status) status.textContent = "Audio could not start. Click Start again.";
    }
}

function stopMetronome() {
    metronomeRunning = false;
    if (metronomeTimer !== null) clearInterval(metronomeTimer);
    metronomeTimer = null;
    const button = document.getElementById("metronome-toggle");
    if (button) { button.textContent = "▶ Metronome"; button.setAttribute("aria-pressed", "false"); }
    const indicator = document.getElementById("metronome-beat");
    if (indicator) { indicator.textContent = "–"; indicator.style.background = "transparent"; indicator.style.color = "inherit"; }
    const status = document.getElementById("metronome-status");
    if (status) status.textContent = "Metronome stopped";
}

function updateMetronomeBpm(value) {
    metronomeBpm = Number(value);
    const label = document.getElementById("metronome-bpm-value");
    if (label) label.textContent = `${metronomeBpm} BPM`;
    const status = document.getElementById("metronome-status");
    if (status && metronomeRunning) status.textContent = `Running at ${metronomeBpm} BPM`;
    if (metronomeRunning) {
        if (metronomeTimer !== null) clearInterval(metronomeTimer);
        metronomeTimer = setInterval(metronomeClick, 60000 / metronomeBpm);
    }
}

// ---------- Create all feature controls dynamically ----------
function createStudioControls() {
    const piano = document.getElementById("piano");
    if (!piano || !piano.parentElement || document.getElementById("piano-studio-controls")) return;

    const panel = document.createElement("section");
    panel.id = "piano-studio-controls";
    panel.setAttribute("aria-label", "Piano studio controls");
    Object.assign(panel.style, {
        display: "flex", flexDirection: "column", gap: "12px", margin: "12px 0",
        padding: "12px", border: "1px solid var(--border-color, #888)", borderRadius: "12px",
        maxWidth: "100%", boxSizing: "border-box"
    });
    const toolbar = document.createElement("div");
    Object.assign(toolbar.style, { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px" });
    const effects = document.createElement("div");
    Object.assign(effects.style, { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "12px" });
    const recordingRow = document.createElement("div");
    Object.assign(recordingRow.style, { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px" });

    const buttonStyle = { padding: "8px 11px", borderRadius: "8px", border: "1px solid #888", cursor: "pointer", font: "inherit", whiteSpace: "nowrap" };
    const makeButton = (id, label, title, handler) => {
        const button = document.createElement("button");
        button.type = "button"; button.id = id; button.textContent = label; button.title = title;
        Object.assign(button.style, buttonStyle); button.addEventListener("click", handler); return button;
    };
    const makeSlider = (id, labelText, min, max, value, valueId, valueText, handler) => {
        const wrap = document.createElement("label");
        Object.assign(wrap.style, { display: "flex", flexDirection: "column", gap: "5px", minWidth: "0", fontSize: "0.9em" });
        const top = document.createElement("span");
        Object.assign(top.style, { display: "flex", justifyContent: "space-between", gap: "8px", alignItems: "center" });
        const name = document.createElement("span"); name.textContent = labelText;
        const val = document.createElement("span"); val.id = valueId; val.textContent = valueText; val.style.fontVariantNumeric = "tabular-nums";
        top.append(name, val);
        const slider = document.createElement("input"); slider.type = "range"; slider.id = id; slider.min = String(min); slider.max = String(max); slider.value = String(value); slider.step = "1";
        slider.style.width = "100%"; slider.addEventListener("input", () => handler(slider.value));
        wrap.append(top, slider); return wrap;
    };

    const heading = document.createElement("strong"); heading.textContent = "Piano controls";
    heading.style.display = "block";
    const rangeRow = document.createElement("div");
    Object.assign(rangeRow.style, { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px" });
    const rangeLabel = document.createElement("strong");
    rangeLabel.id = "piano-range-label";
    rangeLabel.style.flex = "1 1 220px";
    const lowerButton = makeButton("piano-range-lower", "← Lower notes", "Move the visible keyboard one octave lower", () => movePianoRange(-1));
    const higherButton = makeButton("piano-range-higher", "Higher notes →", "Move the visible keyboard one octave higher", () => movePianoRange(1));
    rangeRow.append(lowerButton, rangeLabel, higherButton);

    const instrumentWrap = document.createElement("label");
    instrumentWrap.style.display = "flex"; instrumentWrap.style.flexDirection = "column"; instrumentWrap.style.gap = "4px"; instrumentWrap.style.fontSize = "0.9em";
    instrumentWrap.appendChild(document.createTextNode("Piano type"));
    const instrumentSelect = document.createElement("select"); instrumentSelect.id = "instrument-mode";
    instrumentSelect.style.padding = "8px"; instrumentSelect.style.borderRadius = "8px"; instrumentSelect.style.maxWidth = "100%";
    instrumentSelect.innerHTML = '<option value="acoustic">Acoustic piano (sampled)</option><option value="digital">Digital / electronic piano</option>';
    instrumentSelect.addEventListener("change", () => switchInstrument(instrumentSelect.value));
    const instrumentLabel = document.createElement("span"); instrumentLabel.id = "instrument-mode-label"; instrumentLabel.textContent = "Acoustic piano"; instrumentLabel.style.fontSize = "0.85em";
    instrumentWrap.append(instrumentSelect, instrumentLabel);
    const sustainButton = makeButton("sustain-pedal", "Sustain: OFF", "Keep notes ringing after releasing keys", () => setSustain(!sustainEnabled));
    sustainButton.setAttribute("aria-pressed", "false");
    const metroButton = makeButton("metronome-toggle", "▶ Metronome", "Start or stop the metronome", startMetronome);
    metroButton.setAttribute("aria-pressed", "false");
    const bpmWrap = document.createElement("label"); bpmWrap.htmlFor = "metronome-bpm"; bpmWrap.textContent = "Tempo"; bpmWrap.style.fontSize = "0.9em";
    const bpmSlider = document.createElement("input"); bpmSlider.type = "range"; bpmSlider.id = "metronome-bpm"; bpmSlider.min = "40"; bpmSlider.max = "240"; bpmSlider.value = String(metronomeBpm); bpmSlider.style.width = "100px"; bpmSlider.title = "Tempo in beats per minute";
    bpmSlider.addEventListener("input", () => updateMetronomeBpm(bpmSlider.value));
    const bpmValue = document.createElement("span"); bpmValue.id = "metronome-bpm-value"; bpmValue.textContent = `${metronomeBpm} BPM`; bpmValue.style.fontVariantNumeric = "tabular-nums";
    const beat = document.createElement("span"); beat.id = "metronome-beat"; beat.textContent = "–"; beat.title = "Beat number in a four-beat bar";
    Object.assign(beat.style, { display: "inline-flex", alignItems: "center", justifyContent: "center", width: "28px", height: "28px", border: "1px solid #888", borderRadius: "50%", fontWeight: "700" });
    const metroStatus = document.createElement("span"); metroStatus.id = "metronome-status"; metroStatus.textContent = "Metronome stopped"; metroStatus.style.fontSize = "0.8em";
    toolbar.append(instrumentWrap, sustainButton, metroButton, bpmWrap, bpmSlider, bpmValue, beat, metroStatus);

    effects.append(
        makeSlider("echo-amount", "Echo amount", 0, 70, 0, "echo-value", "0%", setEcho),
        makeSlider("echo-time", "Echo delay", 80, 650, 280, "echo-time-value", "280 ms", setEchoTime),
        makeSlider("reverb-amount", "Reverb / room", 0, 70, 0, "reverb-value", "0%", setReverb),
        makeSlider("master-volume", "Master volume", -30, 6, -3, "master-volume-value", "-3 dB", setVolume)
    );

    const recordButton = makeButton("record-performance", "● Record", "Record the notes you play", startRecording);
    const stopRecordButton = makeButton("stop-recording", "■ Stop recording", "Stop recording the performance", stopRecording);
    const playRecordingButton = makeButton("play-recording", "▶ Play recording", "Play back your recorded notes", playRecording);
    const downloadRecordingButton = makeButton("download-recording", "↓ Export notes", "Download recorded note events as JSON", downloadRecording);
    const clearRecordingButton = makeButton("clear-recording", "Clear recording", "Delete the current recorded performance", clearRecording);
    const recStatus = document.createElement("span"); recStatus.id = "recording-status"; recStatus.textContent = "No performance recorded"; recStatus.style.fontSize = "0.85em";
    recordingRow.append(recordButton, stopRecordButton, playRecordingButton, downloadRecordingButton, clearRecordingButton, recStatus);

    panel.append(heading, rangeRow, toolbar, effects, recordingRow);
    piano.parentElement.insertBefore(panel, piano);
}

// ---------- Computer keyboard and on-screen piano ----------
document.addEventListener("keydown", async (event) => {
    if (event.target instanceof Element && event.target.closest("input, textarea, select, button, [contenteditable='true']")) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.repeat) return;
    const key = event.key.toLowerCase();
    const keyIndex = keyOrder.indexOf(key);
    if (keyIndex < 0 || heldComputerNotes.has(key)) return;
    const midi = visibleStartMidi + keyIndex;
    if (midi > PIANO_MAX_MIDI) return;
    event.preventDefault();
    heldKeys.add(key);
    heldComputerNotes.set(key, midi);
    await pressNote(midi, `keyboard-${key}`);
});

document.addEventListener("keyup", (event) => {
    const key = event.key.toLowerCase();
    const midi = heldComputerNotes.get(key);
    if (midi === undefined) return;
    heldComputerNotes.delete(key);
    heldKeys.delete(key);
    releaseNote(midi, `keyboard-${key}`);
});

window.addEventListener("blur", () => {
    releaseAllManualNotes();
    setSustain(false);
});

function addPianoKeyEvents(key, midi) {
    const source = `mouse-${midi}`;
    key.addEventListener("pointerdown", async (event) => {
        event.preventDefault();
        try { key.setPointerCapture(event.pointerId); } catch (_) {}
        await pressNote(midi, source);
    });
    const release = () => releaseNote(midi, source);
    key.addEventListener("pointerup", release);
    key.addEventListener("pointercancel", release);
    key.addEventListener("lostpointercapture", release);
}

function updateRangeLabel() {
    const label = document.getElementById("piano-range-label");
    if (label) {
        const endMidi = Math.min(visibleStartMidi + VISIBLE_KEY_COUNT - 1, PIANO_MAX_MIDI);
        label.textContent = `Visible range: ${midiToName(visibleStartMidi)} – ${midiToName(endMidi)} (36 keys)`;
    }
    const lower = document.getElementById("piano-range-lower");
    const higher = document.getElementById("piano-range-higher");
    if (lower) lower.disabled = visibleStartMidi <= PIANO_MIN_MIDI;
    if (higher) higher.disabled = visibleStartMidi >= PIANO_MAX_MIDI - VISIBLE_KEY_COUNT + 1;
}

function movePianoRange(direction) {
    const maxStart = PIANO_MAX_MIDI - VISIBLE_KEY_COUNT + 1;
    const nextStart = Math.max(PIANO_MIN_MIDI, Math.min(maxStart, visibleStartMidi + direction * RANGE_STEP));
    if (nextStart === visibleStartMidi) return;
    // Release all held notes before changing the mapping so no note can hang.
    releaseAllManualNotes();
    heldComputerNotes.clear();
    if (pianoSampler && samplesReady) {
        try { pianoSampler.releaseAll(); } catch (_) {}
    }
    sustainedNotes.clear();
    visibleStartMidi = nextStart;
    createPiano();
    updateRangeLabel();
}

function createPiano() {
    const piano = document.getElementById("piano");
    if (!piano) { console.error('Could not find element id="piano" in index.html.'); return; }
    piano.innerHTML = "";
    const whitePitchClasses = [0, 2, 4, 5, 7, 9, 11];
    const isMobile = window.matchMedia("(max-width: 600px)").matches;
    const whiteWidth = isMobile ? 30 : 44;
    const blackWidth = isMobile ? 19 : 28;
    const endMidi = Math.min(visibleStartMidi + VISIBLE_KEY_COUNT - 1, PIANO_MAX_MIDI);
    const visibleNotes = [];
    for (let midi = visibleStartMidi; midi <= endMidi; midi++) visibleNotes.push(midi);
    const whiteNotes = visibleNotes.filter(midi => whitePitchClasses.includes(midi % 12));
    const keyboardWidth = whiteNotes.length * whiteWidth;

    let scroll = document.getElementById("piano-scroll-wrapper");
    if (!scroll) {
        scroll = document.createElement("div");
        scroll.id = "piano-scroll-wrapper";
        Object.assign(scroll.style, { width: "100%", overflowX: "auto", overflowY: "hidden", paddingBottom: "8px", boxSizing: "border-box" });
        piano.parentElement.insertBefore(scroll, piano);
        scroll.appendChild(piano);
    }
    Object.assign(piano.style, { position: "relative", height: isMobile ? "155px" : "190px", width: `${keyboardWidth}px`, minWidth: `${keyboardWidth}px`, overflow: "visible" });

    // Render only the currently selected 36-note window, while the range controls cover all 88 notes.
    let whiteIndex = 0;
    const whitePosition = new Map();
    for (const midi of visibleNotes) {
        if (!whitePitchClasses.includes(midi % 12)) continue;
        const key = document.createElement("button");
        const noteName = midiToName(midi);
        const keyLabel = keyOrder[midi - visibleStartMidi].toUpperCase();
        key.type = "button"; key.dataset.midi = String(midi); key.className = "piano-key white-key";
        key.textContent = keyLabel; key.title = `${noteName} — press ${keyLabel}`;
        key.setAttribute("aria-label", `Play ${noteName}; keyboard key ${keyLabel}`);
        key.style.left = `${whiteIndex * whiteWidth}px`; key.style.width = `${whiteWidth}px`; key.style.height = isMobile ? "150px" : "185px";
        whitePosition.set(midi, whiteIndex * whiteWidth);
        addPianoKeyEvents(key, midi); piano.appendChild(key); whiteIndex++;
    }
    for (const midi of visibleNotes) {
        if (whitePitchClasses.includes(midi % 12)) continue;
        const key = document.createElement("button");
        const noteName = midiToName(midi);
        const keyLabel = keyOrder[midi - visibleStartMidi].toUpperCase();
        key.type = "button"; key.dataset.midi = String(midi); key.className = "piano-key black-key";
        key.textContent = keyLabel; key.title = `${noteName} — press ${keyLabel}`;
        key.setAttribute("aria-label", `Play ${noteName}; keyboard key ${keyLabel}`);
        let whiteKeysBefore = 0;
        for (const whiteMidi of whiteNotes) if (whiteMidi < midi) whiteKeysBefore++;
        key.style.left = `${whiteKeysBefore * whiteWidth - blackWidth / 2}px`; key.style.width = `${blackWidth}px`; key.style.height = isMobile ? "95px" : "120px";
        addPianoKeyEvents(key, midi); piano.appendChild(key);
    }
    updateRangeLabel();
    console.info(`Created ${visibleNotes.length}-note piano window: ${midiToName(visibleStartMidi)} through ${midiToName(endMidi)}.`);
}

// ---------- Text melody player (keeps existing HTML controls) ----------
function stopSong() {
    songToken++;
    songTimers.forEach(timer => clearTimeout(timer)); songTimers = [];
    if (pianoSampler && samplesReady) pianoSampler.releaseAll();
    if (songStatus) songStatus.textContent = "Song stopped.";
}

async function playSong() {
    stopSong();
    const input = document.getElementById("song-input"); if (!input) return;
    const rawNotes = input.value.trim();
    if (!rawNotes) { if (songStatus) songStatus.textContent = "Enter notes first, for example: C4 D4 E4 G4"; return; }
    const midiNotes = rawNotes.split(/[\s,]+/).filter(Boolean).map(noteToMidi);
    if (midiNotes.some(note => note === null)) { if (songStatus) songStatus.textContent = "Invalid note. Try C4, D4, E4, F#4 or Bb3."; return; }
    if (!(await startAudio())) { if (songStatus) songStatus.textContent = "Piano sounds are not ready yet."; return; }
    const token = songToken; const noteDuration = 0.38; const interval = 0.45;
    if (songStatus) songStatus.textContent = "Playing your melody...";
    midiNotes.forEach((midi, index) => {
        songTimers.push(setTimeout(() => {
            if (token !== songToken) return;
            pianoSampler.triggerAttackRelease(midiToName(midi), noteDuration);
            highlightKey(midi, true);
            songTimers.push(setTimeout(() => { if (token === songToken) highlightKey(midi, false); }, noteDuration * 1000));
            if (index === midiNotes.length - 1) songTimers.push(setTimeout(() => { if (token === songToken && songStatus) songStatus.textContent = "Song finished!"; }, noteDuration * 1000));
        }, index * interval * 1000));
    });
}

const playButton = document.getElementById("play-song");
const stopButton = document.getElementById("stop-song");
const clearButton = document.getElementById("clear-song");
if (playButton) playButton.addEventListener("click", playSong);
if (stopButton) stopButton.addEventListener("click", stopSong);
if (clearButton) clearButton.addEventListener("click", () => {
    stopSong(); const input = document.getElementById("song-input"); if (input) input.value = "";
    if (songStatus) songStatus.textContent = "Ready for your first melody.";
});

// ---------- Performance recording and playback ----------
function updateRecordingStatus() {
    const status = document.getElementById("recording-status");
    if (!status) return;
    if (recording) status.textContent = `Recording… ${recordedEvents.length} note events`;
    else if (recordedEvents.length) status.textContent = `Saved ${recordedEvents.length} note events`;
    else status.textContent = "No performance recorded";
}

function startRecording() {
    stopRecordedPlayback();
    recordedEvents = [];
    recordingStartedAt = performance.now();
    recording = true;
    updateRecordingStatus();
}

function stopRecording() {
    if (!recording) return;
    recording = false;
    updateRecordingStatus();
}

function stopRecordedPlayback() {
    recordedPlaybackRunning = false;
    recordedPlaybackToken++;
    recordingTimers.forEach(timer => clearTimeout(timer));
    recordingTimers = [];
    if (pianoSampler && samplesReady) pianoSampler.releaseAll();
    document.querySelectorAll("#piano .piano-key.active").forEach(key => key.classList.remove("active"));
}

async function playRecording() {
    stopRecordedPlayback();
    stopRecording();
    if (!recordedEvents.length) {
        const status = document.getElementById("recording-status"); if (status) status.textContent = "Record a performance first";
        return;
    }
    if (!(await startAudio())) return;
    const token = recordedPlaybackToken;
    recordedPlaybackRunning = true;
    const sortedEvents = [...recordedEvents].sort((a, b) => a.time - b.time);
    sortedEvents.forEach(event => {
        recordingTimers.push(setTimeout(() => {
            if (!recordedPlaybackRunning || token !== recordedPlaybackToken) return;
            const note = midiToName(event.midi);
            if (event.type === "on") { pianoSampler.triggerAttack(note); highlightKey(event.midi, true); }
            else { pianoSampler.triggerRelease(note); highlightKey(event.midi, false); }
        }, event.time));
    });
    const lastTime = sortedEvents[sortedEvents.length - 1].time;
    recordingTimers.push(setTimeout(() => {
        if (token === recordedPlaybackToken) {
            recordedPlaybackRunning = false;
            if (pianoSampler && samplesReady) pianoSampler.releaseAll();
            updateRecordingStatus();
        }
    }, lastTime + 100));
}

function clearRecording() {
    stopRecording(); stopRecordedPlayback(); recordedEvents = []; updateRecordingStatus();
}

function downloadRecording() {
    if (!recordedEvents.length) {
        const status = document.getElementById("recording-status"); if (status) status.textContent = "Record a performance before exporting";
        return;
    }
    const blob = new Blob([JSON.stringify({ format: "virtual-piano-performance-v1", events: recordedEvents }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = "piano-performance.json";
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}

// Initialize the UI and audio. No HTML/CSS changes are required for these controls.
createStudioControls();
createPiano();
initializeAudio();
