import { useState, useEffect, useRef, useCallback } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const NUM_PADS = 16;
const NUM_STEPS = 16;
const NUM_SOUND_BANKS = 16;   
const NUM_PATTERN_BANKS = 16;

const isDrumBank = (idx) => idx > 7;

const DRUM_COLOR = "#e8441a";
const MEL_COLOR  = "#1a8fe8";
const PAT_COLOR  = "#9b1ae8";
const SEQ_COLOR  = "#e8b81a";
const FX_COLOR   = "#e81a6a";

const PAD_COLORS = [
  "#e8441a","#e87a1a","#c8b800","#3ec800",
  "#00c89a","#1a8fe8","#5e1ae8","#c81ae8",
  "#e81a6a","#e8a01a","#a0e81a","#1ae8c8",
  "#1a5ee8","#8e1ae8","#e81aaa","#e84444",
];

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const SCALES = {
  "Chromatic": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  "Major": [0, 2, 4, 5, 7, 9, 11],
  "Minor": [0, 2, 3, 5, 7, 8, 10],
  "Maj Penta": [0, 2, 4, 7, 9],
  "Min Penta": [0, 3, 5, 7, 10],
  "Blues": [0, 3, 5, 6, 7, 10]
};

// ─── Audio Utility (Pitch Detection & Auto-Tune) ──────────────────────────────
function detectPitch(buffer) {
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  
  let maxVol = 0;
  let startIdx = 0;
  for (let i = 0; i < data.length - 4096; i += 1024) {
    let vol = 0;
    for (let j = 0; j < 4096; j++) vol += Math.abs(data[i + j]);
    if (vol > maxVol) { maxVol = vol; startIdx = i; }
  }
  
  if (maxVol < 10) return null;
  const slice = data.slice(startIdx, startIdx + 4096);
  
  let bestOffset = -1;
  let bestCorr = 0;
  for (let offset = 20; offset < 2000; offset++) {
    let corr = 0;
    for (let i = 0; i < 2000; i++) corr += slice[i] * slice[i + offset];
    if (corr > bestCorr) { bestCorr = corr; bestOffset = offset; }
  }
  
  if (bestCorr > 0.01) return sr / bestOffset;
  return null;
}

function getPitchShiftToC(freq) {
  if (!freq) return { shift: 1.0, note: "Unknown" };
  const midiNote = Math.round(12 * Math.log2(freq / 440)) + 69;
  const noteIdx = midiNote % 12;
  let semitonesToC = noteIdx <= 6 ? -noteIdx : 12 - noteIdx;
  return { shift: Math.pow(2, semitonesToC / 12), note: NOTE_NAMES[noteIdx] };
}

// ─── Audio Utility (Noise Gate + Transient Slicing) ───────────────────────────
function detectTransients(buf, threshold = 0.08, minGap = 0.05) {
  const data = buf.getChannelData(0);
  let maxAmp = 0;
  for (let i = 0; i < data.length; i++) maxAmp = Math.max(maxAmp, Math.abs(data[i]));
  
  if (maxAmp > 0.03) {
    const multiplier = Math.min(1.0 / maxAmp, 10);
    for (let i = 0; i < data.length; i++) data[i] *= multiplier;
  } else {
    for (let i = 0; i < data.length; i++) data[i] = 0;
  }

  const sr = buf.sampleRate;
  const win = Math.floor(sr * 0.01);
  const minGapS = Math.floor(sr * minGap);
  const out = [0];
  let last = 0, prevRms = 0;
  
  for (let i = win; i < data.length - win; i += win) {
    let rms = 0;
    for (let j = i; j < i + win; j++) rms += data[j] * data[j];
    rms = Math.sqrt(rms / win);
    if (rms - prevRms > threshold && i - last > minGapS) { out.push(i); last = i; }
    prevRms = rms;
  }
  out.push(data.length);
  
  if (out.length < 4) {
    const equalOut = [0];
    const step = Math.floor(data.length / 16);
    for (let i = 1; i < 16; i++) equalOut.push(i * step);
    equalOut.push(data.length);
    return equalOut;
  }
  return out;
}

function sliceBuffer(audioBuf, transients, ctx) {
  const slices = [];
  for (let i = 0; i < transients.length - 1 && slices.length < NUM_PADS; i++) {
    const len = transients[i + 1] - transients[i];
    if (len < audioBuf.sampleRate * 0.02) continue;
    const s = ctx.createBuffer(1, len, audioBuf.sampleRate);
    s.copyToChannel(audioBuf.getChannelData(0).slice(transients[i], transients[i + 1]), 0);
    slices.push(s);
  }
  return slices;
}

function extractWaveform(buf, pts = 40) {
  const data = buf.getChannelData(0);
  const step = Math.floor(data.length / pts);
  return Array.from({ length: pts }, (_, i) => {
    let max = 0;
    for (let j = i * step; j < (i + 1) * step && j < data.length; j++)
      max = Math.max(max, Math.abs(data[j]));
    return max;
  });
}

// ─── Initial state factories ──────────────────────────────────────────────────
const mkSoundBanks  = () => Array(NUM_SOUND_BANKS).fill(null).map(() => Array(NUM_PADS).fill(null));
const mkWaveforms   = () => Array(NUM_SOUND_BANKS).fill(null).map(() => Array(NUM_PADS).fill(null));
const mkPadParams   = () => Array(NUM_SOUND_BANKS).fill(null).map(() => Array(NUM_PADS).fill({ pitch: 1.0, filter: 50, trimStart: 0.0, trimEnd: 1.0, gain: 1.0 }));
const mkPatternBanks = () => Array(NUM_PATTERN_BANKS).fill(null).map(() => ({
  grid: Array(NUM_SOUND_BANKS).fill(null).map(() => Array(NUM_PADS).fill(null).map(() => Array(NUM_STEPS).fill({ active: false, retrig: 0 })))
}));

// ─── Components ───────────────────────────────────────────────────────────────
function WaveformMini({ data, color = "#fff", h = 22, w = 52, trimStart = 0, trimEnd = 1 }) {
  if (!data) return null;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - v * h}`).join(" ");
  return (
    <svg width={w} height={h} style={{ opacity: 0.8 }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
      <rect x={0} y={0} width={w * trimStart} height={h} fill="#111" opacity="0.85" />
      <rect x={w * trimEnd} y={0} width={w * (1 - trimEnd)} height={h} fill="#111" opacity="0.85" />
    </svg>
  );
}

const baseBtn = (active, color = "#444", bg = "#1a1a1a") => ({
  background: active ? color + "22" : bg,
  border: `1.5px solid ${active ? color : "#2a2a2a"}`,
  color: active ? color : "#555",
  borderRadius: "6px", padding: "6px 10px", cursor: "pointer",
  fontSize: "10px", fontFamily: "'Courier New', monospace", letterSpacing: "1.5px",
  transition: "all 0.08s",
});

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function KOSampler() {
  const audioCtxRef  = useRef(null);
  const recorderRef  = useRef(null);
  const recChunksRef = useRef([]);
  const schedulerRef = useRef(null);
  const stepRef      = useRef(0);
  const chainIdxRef  = useRef(0); 
  const nextTimeRef  = useRef(0);
  const activeSrcRef = useRef([]);

  // ─── State ─────────────────────────────────────────────────────────────────
  const [soundBanks,   setSoundBanks]   = useState(mkSoundBanks);
  const [waveforms,    setWaveforms]    = useState(mkWaveforms);
  const [padParams,    setPadParams]    = useState(mkPadParams);
  const [patternBanks, setPatternBanks] = useState(mkPatternBanks);
  
  const [mode, setMode] = useState("sound");
  const [activeSoundBank,   setActiveSoundBank]   = useState(0);
  const [activePatternBank, setActivePatternBank] = useState(0);
  const [songChain,    setSongChain]    = useState([0]);
  const [chainPlaying, setChainPlaying] = useState(false); 
  
  const [selectedPad,    setSelectedPad]    = useState(null);
  const [isPlaying,      setIsPlaying]      = useState(false);
  const [isRecording,    setIsRecording]    = useState(false);
  
  const [currentStep,    setCurrentStep]    = useState(-1);
  const [currentChainIdx,setCurrentChainIdx]= useState(0);
  
  const [bpm,            setBpm]            = useState(120);
  const [swing,          setSwing]          = useState(0); 
  const [keySig,         setKeySig]         = useState(0); 
  const [scale,          setScale]          = useState("Chromatic");

  const [volume,         setVolume]         = useState(0.8);
  const [status,         setStatus]         = useState("Ready");
  const [flashPad,       setFlashPad]       = useState(null);
  const [activeFX,       setActiveFX]       = useState(null);

  const [clipboardPattern, setClipboardPattern] = useState(null);

  const stateRef = useRef({
    soundBanks, patternBanks, padParams, songChain, 
    chainPlaying, activePat: activePatternBank, bpm, volume, swing, activeFX, keySig, scale
  });

  useEffect(() => {
    stateRef.current = { soundBanks, patternBanks, padParams, songChain, chainPlaying, activePat: activePatternBank, bpm, volume, swing, activeFX, keySig, scale };
  }, [soundBanks, patternBanks, padParams, songChain, chainPlaying, activePatternBank, bpm, volume, swing, activeFX, keySig, scale]);

  // ─── Save / Load System ─────────────────────────────────────────────────────
  const saveProject = (slot) => {
    const projectData = {
      patternBanks, songChain, padParams, bpm, swing, scale, keySig
    };
    localStorage.setItem(`umami_save_${slot}`, JSON.stringify(projectData));
    setStatus(`Project Saved to Slot ${slot}`);
  };

  const loadProject = (slot) => {
    const data = localStorage.getItem(`umami_save_${slot}`);
    if (data) {
      const parsed = JSON.parse(data);
      setPatternBanks(parsed.patternBanks);
      setSongChain(parsed.songChain);
      setPadParams(parsed.padParams);
      setBpm(parsed.bpm);
      setSwing(parsed.swing);
      if(parsed.scale) setScale(parsed.scale);
      if(parsed.keySig !== undefined) setKeySig(parsed.keySig);
      setStatus(`Loaded Project Slot ${slot}`);
    } else {
      setStatus(`Save Slot ${slot} is empty`);
    }
  };

  // ─── Audio Engine ───────────────────────────────────────────────────────────
  const getCtx = useCallback(() => {
    if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtxRef.current.state === "suspended") audioCtxRef.current.resume();
    return audioCtxRef.current;
  }, []);

  const playPad = useCallback((padIdx, soundBankIdx, when = 0, retrig = 0) => {
    const ctx = getCtx();
    const st = stateRef.current;
    
    const targetBufferIdx = !isDrumBank(soundBankIdx) ? 8 : padIdx;
    const buf = st.soundBanks[soundBankIdx]?.[targetBufferIdx];
    if (!buf) return;
    
    const count = retrig > 0 ? retrig : 1;
    const beatLen = 60 / st.bpm / 4;
    const durPerSubStep = retrig > 0 ? beatLen / count : beatLen;

    for (let i = 0; i < count; i++) {
        const subWhen = when + (i * durPerSubStep);
        
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const params = st.padParams[soundBankIdx][padIdx];
        
        let playbackRate = !isDrumBank(soundBankIdx) ? st.padParams[soundBankIdx][8].pitch : params.pitch;

        if (!isDrumBank(soundBankIdx)) {
          const sArr = SCALES[st.scale] || SCALES["Chromatic"];
          const diff = padIdx - 8;
          const octave = Math.floor(diff / sArr.length);
          const degree = (diff % sArr.length + sArr.length) % sArr.length;
          const semitones = octave * 12 + sArr[degree] + st.keySig; 
          
          playbackRate *= Math.pow(2, semitones / 12);
        }

        if (st.activeFX === "PITCH_DOWN") playbackRate *= 0.5;
        src.playbackRate.value = playbackRate;

        const filter = ctx.createBiquadFilter();
        if (st.activeFX === "LOWPASS") { filter.type = "lowpass"; filter.frequency.value = 600; } 
        else if (st.activeFX === "HIGHPASS") { filter.type = "highpass"; filter.frequency.value = 4000; } 
        else if (params.filter < 50) { filter.type = "lowpass"; filter.frequency.value = 200 + (params.filter / 50) * 18000; } 
        else if (params.filter > 50) { filter.type = "highpass"; filter.frequency.value = ((params.filter - 50) / 50) * 10000; } 
        else { filter.type = "allpass"; }

        const gain = ctx.createGain();
        const padGain = params.gain !== undefined ? params.gain : 1.0;
        gain.gain.value = st.volume * padGain;
        
        src.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);

        const duration = buf.duration;
        const trimParams = !isDrumBank(soundBankIdx) ? st.padParams[soundBankIdx][8] : params;
        const offset = trimParams.trimStart * duration;
        const playLen = (trimParams.trimEnd - trimParams.trimStart) * duration;
        
        if (playLen <= 0.01) continue;
        
        activeSrcRef.current = activeSrcRef.current.filter(item => {
          if (!isDrumBank(soundBankIdx) && item.soundBankIdx === soundBankIdx) {
            try { item.src.stop(subWhen || ctx.currentTime); } catch(e){}
            return false;
          }
          if (isDrumBank(soundBankIdx) && item.soundBankIdx === soundBankIdx && item.padIdx === padIdx) {
            try { item.src.stop(subWhen || ctx.currentTime); } catch(e){}
            return false;
          }
          return true;
        });

        if (activeSrcRef.current.length >= 8) {
          const oldest = activeSrcRef.current.shift();
          try { oldest.src.stop(subWhen || ctx.currentTime); } catch(e) {}
        }

        src.start(subWhen || ctx.currentTime, offset, playLen);
        activeSrcRef.current.push({ src, padIdx, soundBankIdx });

        if (st.activeFX === "STUTTER" && subWhen > 0 && i === 0) {
          const beatLenFx = 60 / st.bpm / 4;
          const stutterSrc = ctx.createBufferSource();
          stutterSrc.buffer = buf;
          stutterSrc.playbackRate.value = playbackRate;
          stutterSrc.connect(filter);
          stutterSrc.start(subWhen + (beatLenFx / 2), offset, playLen);
        }

        src.onended = () => { activeSrcRef.current = activeSrcRef.current.filter(s => s.src !== src); };
    }
    
    if (!when) { setFlashPad(padIdx); setTimeout(() => setFlashPad(null), 120); }
  }, [getCtx]);

  // ─── Scheduler ──────────────────────────────────────────────────────────────
  const scheduleStep = useCallback(() => {
    const ctx = getCtx();
    const ahead = 0.1;
    const st = stateRef.current;
    const beatLen = 60 / st.bpm / 4;

    while (nextTimeRef.current < ctx.currentTime + ahead) {
      const step = stepRef.current;
      let patIdx = st.chainPlaying && st.songChain.length > 0 ? st.songChain[chainIdxRef.current % st.songChain.length] : st.activePat;
      const pat = st.patternBanks[patIdx];

      let swingOffset = 0;
      if (step % 2 !== 0) swingOffset = beatLen * (st.swing / 100);

      pat.grid.forEach((bankSteps, sbIdx) => {
        bankSteps.forEach((padSteps, padIdx) => {
          if (padSteps[step].active) playPad(padIdx, sbIdx, nextTimeRef.current + swingOffset, padSteps[step].retrig);
        });
      });

      setCurrentStep(step);
      stepRef.current = (step + 1) % NUM_STEPS;
      if (stepRef.current === 0) {
        if (st.chainPlaying && st.songChain.length > 0) {
          chainIdxRef.current = (chainIdxRef.current + 1) % st.songChain.length;
          setCurrentChainIdx(chainIdxRef.current);
        }
      }
      nextTimeRef.current += beatLen;
    }
  }, [getCtx, playPad]);

  useEffect(() => {
    if (isPlaying) {
      const ctx = getCtx();
      nextTimeRef.current = ctx.currentTime;
      stepRef.current     = 0;
      chainIdxRef.current = 0;
      setCurrentChainIdx(0);
      schedulerRef.current = setInterval(scheduleStep, 25);
    } else {
      clearInterval(schedulerRef.current);
      setCurrentStep(-1);
      activeSrcRef.current.forEach(s => { try { s.src.stop(); } catch (e) {} });
      activeSrcRef.current = [];
    }
    return () => clearInterval(schedulerRef.current);
  }, [isPlaying, scheduleStep, getCtx]);

  // ─── Recording & Deleting ───────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    try {
      const ctx = getCtx();
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { noiseSuppression: true, echoCancellation: false, autoGainControl: false } 
      });
      recChunksRef.current = [];
      const rec = new MediaRecorder(stream);
      recorderRef.current = rec;
      rec.ondataavailable = e => recChunksRef.current.push(e.data);
      rec.onstop = async () => {
        const blob     = new Blob(recChunksRef.current, { type: "audio/webm" });
        const arrBuf   = await blob.arrayBuffer();
        const audioBuf = await ctx.decodeAudioData(arrBuf);
        stream.getTracks().forEach(t => t.stop());

        if (isDrumBank(activeSoundBank)) {
          const transients = detectTransients(audioBuf);
          const slices     = sliceBuffer(audioBuf, transients, ctx);
          setSoundBanks(prev => {
            const next = prev.map(b => [...b]);
            slices.forEach((s, i) => { next[activeSoundBank][i] = s; });
            return next;
          });
          setWaveforms(prev => {
            const next = prev.map(b => [...b]);
            slices.forEach((s, i) => { next[activeSoundBank][i] = extractWaveform(s); });
            return next;
          });
          setStatus(`Sliced → ${slices.length} pads in D${activeSoundBank - 7}`);
        } else {
          const freq = detectPitch(audioBuf);
          const { shift, note } = getPitchShiftToC(freq);

          setSoundBanks(prev => {
            const next = prev.map(b => [...b]);
            next[activeSoundBank][8] = audioBuf;
            return next;
          });
          setWaveforms(prev => {
            const next = prev.map(b => [...b]);
            next[activeSoundBank][8] = extractWaveform(audioBuf);
            return next;
          });
          
          setPadParams(prev => {
            const next = prev.map(b => [...b]);
            next[activeSoundBank][8] = { ...next[activeSoundBank][8], pitch: shift };
            return next;
          });

          setStatus(note !== "Unknown" ? `Auto-Tuned ${note} → Base C` : `M${activeSoundBank + 1} Recorded.`);
        }
        setIsRecording(false);
      };
      rec.start();
      setIsRecording(true);
      setStatus(`Recording ${isDrumBank(activeSoundBank) ? "Drum Loop..." : "Melodic Sample..."}`);
    } catch {
      setStatus("Mic access denied");
      setIsRecording(false);
    }
  }, [getCtx, activeSoundBank]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current?.state !== "inactive") recorderRef.current.stop();
  }, []);

  const clearPad = () => {
    if (selectedPad === null) return;
    setSoundBanks(prev => {
      const next = prev.map(b => [...b]);
      if (!isDrumBank(activeSoundBank)) next[activeSoundBank][8] = null; 
      else next[activeSoundBank][selectedPad] = null; 
      return next;
    });
    setWaveforms(prev => {
      const next = prev.map(b => [...b]);
      if (!isDrumBank(activeSoundBank)) next[activeSoundBank][8] = null;
      else next[activeSoundBank][selectedPad] = null;
      return next;
    });
    setStatus(`Cleared Pad in ${isDrumBank(activeSoundBank) ? "D" : "M"}${isDrumBank(activeSoundBank) ? activeSoundBank - 7 : activeSoundBank + 1}`);
  };

  const updatePadParam = (param, value) => {
    if (selectedPad === null) return;
    setPadParams(prev => {
      const next = prev.map(b => [...b]);
      const targetPad = !isDrumBank(activeSoundBank) ? 8 : selectedPad;
      const current = next[activeSoundBank][targetPad];
      
      let finalVal = value;
      if (param === "trimStart" && finalVal >= current.trimEnd) finalVal = current.trimEnd - 0.01;
      if (param === "trimEnd" && finalVal <= current.trimStart) finalVal = current.trimStart + 0.01;
      
      next[activeSoundBank][targetPad] = { ...current, [param]: finalVal };
      return next;
    });
  };

  // ─── Pattern & Song Functions ───────────────────────────────────────────────
  const toggleStep = (sbIdx, padIdx, stepIdx, action = "toggle") => {
    setPatternBanks(prev => prev.map((pat, pi) => {
      if (pi !== activePatternBank) return pat;
      const newGrid = pat.grid.map((bank, bi) => {
        if (bi !== sbIdx) return bank;
        return bank.map((pad, p_idx) => {
          if (p_idx !== padIdx) return pad;
          return pad.map((stepData, si) => {
            if (si !== stepIdx) return stepData;
            if (action === "retrig") {
              const nextRetrig = stepData.retrig === 0 ? 2 : stepData.retrig === 2 ? 4 : stepData.retrig === 4 ? 8 : 0;
              return { ...stepData, retrig: nextRetrig, active: true };
            }
            return { ...stepData, active: !stepData.active };
          });
        });
      });
      return { ...pat, grid: newGrid };
    }));
  };

  const copyPattern = () => {
    const copiedGrid = JSON.parse(JSON.stringify(patternBanks[activePatternBank].grid));
    setClipboardPattern(copiedGrid);
    setStatus(`Pattern ${activePatternBank + 1} Copied`);
  };

  const pastePattern = () => {
    if (!clipboardPattern) return;
    setPatternBanks(prev => prev.map((pat, i) => 
      i === activePatternBank ? { ...pat, grid: JSON.parse(JSON.stringify(clipboardPattern)) } : pat
    ));
    setStatus(`Pasted to Pattern ${activePatternBank + 1}`);
  };

  const addToChain      = (patIdx) => setSongChain(prev => [...prev, patIdx]);
  const removeFromChain = (pos)    => setSongChain(prev => prev.filter((_, i) => i !== pos));
  const clearChain      = ()       => setSongChain([]);

  const sbLabel = (i) => `${isDrumBank(i) ? "D" : "M"}${isDrumBank(i) ? i - 7 : i + 1}`;
  const activePat = patternBanks[activePatternBank];
  const displayParamsIdx = (selectedPad !== null && !isDrumBank(activeSoundBank)) ? 8 : selectedPad;
  const activeParams = displayParamsIdx !== null ? padParams[activeSoundBank][displayParamsIdx] : { pitch: 1, filter: 50, trimStart: 0, trimEnd: 1, gain: 1 };

  // ─── UI Helpers ─────────────────────────────────────────────────────────────
  const getMelodicPadLabel = (padIdx) => {
    const sArr = SCALES[scale] || SCALES["Chromatic"];
    const diff = padIdx - 8;
    const degree = (diff % sArr.length + sArr.length) % sArr.length;
    const semitones = sArr[degree] + keySig;
    const noteName = NOTE_NAMES[(semitones % 12 + 12) % 12];
    return padIdx === 8 ? `${noteName} (RT)` : noteName;
  };

  // ─── UI ─────────────────────────────────────────────────────────────────────
  return (
    <div style={{
      background: "#0d0d0d", minHeight: "100vh", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", fontFamily: "'Courier New', monospace",
      color: "#fff", padding: "16px", boxSizing: "border-box", userSelect: "none"
    }}>
      <div style={{
        background: "#161616", borderRadius: "20px", padding: "20px", width: "100%", maxWidth: "560px",
        boxShadow: "0 0 80px rgba(0,0,0,0.9), inset 0 1px 0 rgba(255,255,255,0.04)", border: "1px solid #252525", position: "relative"
      }}>

        {/* ── Header & Screen ── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <div>
            <div style={{ fontSize: "10px", letterSpacing: "3px", color: "#888" }}>🍜 UMAMI</div>
            <div style={{ fontSize: "22px", fontWeight: "bold", letterSpacing: "2px", color: "#fff" }}>SAMPLER</div>
          </div>
          <div style={{
            background: "#080808", border: "1px solid #2a2a2a", borderRadius: "8px",
            padding: "8px 16px", textAlign: "center", minWidth: "190px",
          }}>
            <div style={{ fontSize: "9px", color: "#444", letterSpacing: "2px", marginBottom: "2px" }}>
              {mode === "sound" ? `SOUND BANK · ${sbLabel(activeSoundBank)}` : mode === "pattern" ? `PATTERN · P${activePatternBank + 1}` : `SONG CHAIN`}
            </div>
            <div style={{ fontSize: "12px", color: activeFX ? FX_COLOR : isRecording ? "#ff4444" : "#e8441a", letterSpacing: "1px" }}>
              {activeFX ? `FX: ${activeFX}` : status}
            </div>
            <div style={{ fontSize: "9px", color: "#3a3a3a", marginTop: "2px" }}>
              {isPlaying ? `▶ ${bpm} BPM · SWING ${swing}%` : `■ ${bpm} BPM`}
            </div>
          </div>
        </div>

        {/* ── Mode selector ── */}
        <div style={{ display: "flex", gap: "6px", marginBottom: "12px" }}>
          <button onClick={() => setMode("sound")} style={{...baseBtn(mode === "sound", DRUM_COLOR), flex: 1 }}>SOUND</button>
          <button onClick={() => setMode("pattern")} style={{...baseBtn(mode === "pattern", PAT_COLOR), flex: 1 }}>PATTERN</button>
          <button onClick={() => setMode("song")} style={{...baseBtn(mode === "song", SEQ_COLOR), flex: 1 }}>SONG</button>
        </div>

        {/* ── Parameters (Pitch, Filter, Gain, Trim & Clear) ── */}
        {(mode === "sound" || mode === "pattern") && selectedPad !== null && (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginBottom: "16px", background: "#111", padding: "10px", borderRadius: "8px" }}>
             <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
                 <div style={{ flex: 1 }}>
                    <div style={{ fontSize: "9px", color: "#666", marginBottom: "6px" }}>PITCH { !isDrumBank(activeSoundBank) ? "(AUTO-TUNED)" : "" }</div>
                    <input type="range" min="0.5" max="2.0" step="0.05" value={activeParams.pitch}
                      onChange={(e) => updatePadParam("pitch", parseFloat(e.target.value))}
                      style={{ width: "100%", accentColor: MEL_COLOR }} />
                 </div>
                 <div style={{ flex: 1 }}>
                    <div style={{ fontSize: "9px", color: "#666", marginBottom: "6px" }}>FILTER</div>
                    <input type="range" min="0" max="100" value={activeParams.filter}
                      onChange={(e) => updatePadParam("filter", parseInt(e.target.value))}
                      style={{ width: "100%", accentColor: DRUM_COLOR }} />
                 </div>
                 <div style={{ flex: 1 }}>
                    <div style={{ fontSize: "9px", color: "#666", marginBottom: "6px" }}>GAIN</div>
                    <input type="range" min="0" max="2" step="0.05" value={activeParams.gain !== undefined ? activeParams.gain : 1.0}
                      onChange={(e) => updatePadParam("gain", parseFloat(e.target.value))}
                      style={{ width: "100%", accentColor: SEQ_COLOR }} />
                 </div>
             </div>
             <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
                 <div style={{ flex: 1 }}>
                    <div style={{ fontSize: "9px", color: "#666", marginBottom: "6px" }}>TRIM START</div>
                    <input type="range" min="0" max="0.99" step="0.01" value={activeParams.trimStart}
                      onChange={(e) => updatePadParam("trimStart", parseFloat(e.target.value))}
                      style={{ width: "100%", accentColor: "#a0e81a" }} />
                 </div>
                 <div style={{ flex: 1 }}>
                    <div style={{ fontSize: "9px", color: "#666", marginBottom: "6px" }}>TRIM END</div>
                    <input type="range" min="0.01" max="1" step="0.01" value={activeParams.trimEnd}
                      onChange={(e) => updatePadParam("trimEnd", parseFloat(e.target.value))}
                      style={{ width: "100%", accentColor: "#e81a6a" }} />
                 </div>
                 <div style={{ flex: 1, display: "flex", justifyContent: "flex-end" }}>
                   {mode === "sound" ? (
                      <button onClick={clearPad} style={{ ...baseBtn(false, "#ff4444", "#331111"), padding: "8px 12px", width: "100%" }}>
                        CLEAR<br/>PAD
                      </button>
                   ) : (
                      <div style={{ width: "100%" }} />
                   )}
                 </div>
             </div>
          </div>
        )}

        {/* ── SOUND MODE GRID ── */}
        {mode === "sound" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: "4px", marginBottom: "14px" }}>
              {Array(8).fill(null).map((_, i) => (
                <button key={i} onClick={() => setActiveSoundBank(i)} style={{...baseBtn(activeSoundBank === i, MEL_COLOR), padding: "5px 0", fontSize: "9px" }}>M{i + 1}</button>
              ))}
              {Array(8).fill(null).map((_, i) => (
                <button key={i + 8} onClick={() => setActiveSoundBank(i + 8)} style={{...baseBtn(activeSoundBank === i + 8, DRUM_COLOR), padding: "5px 0", fontSize: "9px" }}>D{i + 1}</button>
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px", marginBottom: "14px" }}>
              {Array(NUM_PADS).fill(null).map((_, padIdx) => {
                const isMelodic = !isDrumBank(activeSoundBank);
                const hasSample = isMelodic ? !!soundBanks[activeSoundBank][8] : !!soundBanks[activeSoundBank][padIdx];
                const col = PAD_COLORS[padIdx];
                const displayWaveform = isMelodic ? (padIdx === 8 ? waveforms[activeSoundBank][8] : null) : waveforms[activeSoundBank][padIdx];
                
                const paramIdx = isMelodic ? 8 : padIdx;
                const padParamsData = padParams[activeSoundBank][paramIdx];

                return (
                  <button key={padIdx}
                    onClick={() => {
                      if (isRecording) { stopRecording(); return; }
                      setSelectedPad(padIdx);
                      if (hasSample) playPad(padIdx, activeSoundBank);
                    }}
                    style={{
                      background: flashPad === padIdx ? col : hasSample ? col + "1a" : "#111",
                      border: `1.5px solid ${selectedPad === padIdx ? col : hasSample ? col + "88" : "#222"}`,
                      borderRadius: "8px", height: "68px", position: "relative", cursor: "pointer"
                    }}>
                    <div style={{ fontSize: "8px", color: hasSample ? col : "#2a2a2a", position: "absolute", top: "4px", left: "6px" }}>
                      {String(padIdx + 1).padStart(2, "0")}
                    </div>
                    {displayWaveform ? (
                      <div style={{ position: "absolute", bottom: "4px", left: "50%", transform: "translateX(-50%)" }}>
                        <WaveformMini data={displayWaveform} color={col} trimStart={padParamsData.trimStart} trimEnd={padParamsData.trimEnd} />
                      </div>
                    ) : (hasSample && isMelodic) ? (
                       <div style={{ color: col, opacity: 0.8, fontSize: "11px", fontWeight: "bold" }}>{getMelodicPadLabel(padIdx)}</div>
                    ) : <div style={{ color: "#222" }}>+</div>}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* ── PATTERN MODE ── */}
        {mode === "pattern" && (
          <>
            <div style={{ marginBottom: "10px" }}>
              <div style={{ fontSize: "9px", color: "#444", letterSpacing: "2px", marginBottom: "6px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>PATTERN BANKS</span>
                <div style={{ display: "flex", gap: "6px" }}>
                  <button onClick={copyPattern} style={{ ...baseBtn(false, "#fff", "#222"), padding: "2px 6px", fontSize: "8px" }}>COPY</button>
                  <button onClick={pastePattern} disabled={!clipboardPattern} style={{ ...baseBtn(false, clipboardPattern ? "#fff" : "#444", clipboardPattern ? "#222" : "#111"), padding: "2px 6px", fontSize: "8px", opacity: clipboardPattern ? 1 : 0.5 }}>PASTE</button>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: "4px", marginBottom: "4px" }}>
                {Array(8).fill(null).map((_, i) => (
                  <button key={i} onClick={() => setActivePatternBank(i)} style={{
                    ...baseBtn(activePatternBank === i, PAT_COLOR), padding: "5px 2px", fontSize: "9px", borderRadius: "4px",
                  }}>P{i + 1}</button>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: "4px" }}>
                {Array(8).fill(null).map((_, i) => (
                  <button key={i + 8} onClick={() => setActivePatternBank(i + 8)} style={{
                    ...baseBtn(activePatternBank === i + 8, PAT_COLOR), padding: "5px 2px", fontSize: "9px", borderRadius: "4px",
                  }}>P{i + 9}</button>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: "10px" }}>
              <div style={{ fontSize: "9px", color: "#444", letterSpacing: "2px", marginBottom: "6px" }}>
                SELECT SOUND BANK FOR TRACK
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: "4px", marginBottom: "4px" }}>
                {Array(8).fill(null).map((_, i) => (
                  <button key={i} onClick={() => setActiveSoundBank(i)} style={{
                    ...baseBtn(activeSoundBank === i, MEL_COLOR), padding: "5px 2px", fontSize: "9px", borderRadius: "4px",
                  }}>M{i + 1}</button>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: "4px" }}>
                {Array(8).fill(null).map((_, i) => (
                  <button key={i + 8} onClick={() => setActiveSoundBank(i + 8)} style={{
                    ...baseBtn(activeSoundBank === i + 8, DRUM_COLOR), padding: "5px 2px", fontSize: "9px", borderRadius: "4px",
                  }}>D{i + 1}</button>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: "8px" }}>
              <div style={{ fontSize: "9px", color: "#444", letterSpacing: "2px", marginBottom: "6px" }}>
                SELECT PAD TO SEQUENCE
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: "4px" }}>
                {Array(NUM_PADS).fill(null).map((_, padIdx) => {
                  const col = PAD_COLORS[padIdx];
                  const hasSteps = activePat.grid[activeSoundBank][padIdx].some(s => s.active);
                  const isMelodic = !isDrumBank(activeSoundBank);
                  const hasSample = isMelodic ? !!soundBanks[activeSoundBank][8] : !!soundBanks[activeSoundBank][padIdx];
                  return (
                    <button key={padIdx} onClick={() => {
                        setSelectedPad(p => p === padIdx ? null : padIdx);
                        if (hasSample) playPad(padIdx, activeSoundBank);
                      }} style={{
                      ...baseBtn(selectedPad === padIdx, col),
                      padding: "5px 2px", fontSize: "9px", borderRadius: "4px",
                      border: `1.5px solid ${selectedPad === padIdx ? col : hasSteps ? col + "66" : "#222"}`,
                      opacity: hasSample ? 1 : 0.4,
                    }}>{String(padIdx + 1).padStart(2, "0")}</button>
                  );
                })}
              </div>
            </div>

            {selectedPad !== null && (
              <div style={{ marginBottom: "10px" }}>
                <div style={{ fontSize: "9px", color: "#555", letterSpacing: "2px", marginBottom: "6px" }}>
                  STEPS · BANK {sbLabel(activeSoundBank)} · PAD {String(selectedPad + 1).padStart(2, "0")} · P{activePatternBank + 1}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(16, 1fr)", gap: "4px" }}>
                  {activePat.grid[activeSoundBank][selectedPad].map((stepData, si) => {
                    const on  = stepData.active;
                    const cur = si === currentStep && isPlaying;
                    const col = PAD_COLORS[selectedPad];
                    return (
                      <div key={si} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                        <button onClick={() => toggleStep(activeSoundBank, selectedPad, si, "toggle")} style={{
                          aspectRatio: "1 / 1", width: "100%", padding: 0, borderRadius: "4px", cursor: "pointer",
                          background: cur ? "#fff" : on ? col : "#1e1e1e",
                          border: `1px solid ${cur ? "#fff" : on ? col : "#333"}`,
                          boxShadow: on ? `inset 0 2px 4px rgba(255,255,255,0.4), 0 0 8px ${col}66` : "inset 0 3px 6px rgba(0,0,0,0.6)",
                          transition: "all 0.05s"
                        }} />
                        <button onClick={() => toggleStep(activeSoundBank, selectedPad, si, "retrig")} style={{
                          height: "12px", padding: 0, borderRadius: "2px", cursor: "pointer", fontSize: "8px", fontWeight: "bold",
                          background: stepData.retrig ? FX_COLOR : "#111", color: "#fff", border: "none"
                        }}>
                          {stepData.retrig ? stepData.retrig : ""}
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div style={{ fontSize: "8px", color: "#444", marginTop: "8px", letterSpacing: "1px" }}>TOP ROW: ON/OFF | BOTTOM ROW: CLICK TO CYCLE RETRIG (2, 4, 8)</div>
              </div>
            )}
          </>
        )}

        {/* ── SONG MODE & MEMORY ── */}
        {mode === "song" && (
          <>
            <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
                <div style={{ flex: 1, background: "#111", padding: "10px", borderRadius: "8px" }}>
                   <div style={{ fontSize: "9px", color: "#666", marginBottom: "6px" }}>SAVE PROJECT</div>
                   <div style={{ display: "flex", gap: "4px" }}>
                     {[1,2,3,4].map(slot => (
                       <button key={`save-${slot}`} onClick={() => saveProject(slot)} style={{...baseBtn(false, MEL_COLOR), flex: 1, padding: "8px 0", fontWeight: "bold"}}>S{slot}</button>
                     ))}
                   </div>
                </div>
                <div style={{ flex: 1, background: "#111", padding: "10px", borderRadius: "8px" }}>
                   <div style={{ fontSize: "9px", color: "#666", marginBottom: "6px" }}>LOAD PROJECT</div>
                   <div style={{ display: "flex", gap: "4px" }}>
                     {[1,2,3,4].map(slot => (
                       <button key={`load-${slot}`} onClick={() => loadProject(slot)} style={{...baseBtn(false, DRUM_COLOR), flex: 1, padding: "8px 0", fontWeight: "bold"}}>L{slot}</button>
                     ))}
                   </div>
                </div>
            </div>

            <div style={{ marginBottom: "10px" }}>
              <div style={{ fontSize: "9px", color: "#444", letterSpacing: "2px", marginBottom: "6px" }}>
                ADD PATTERN TO CHAIN
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: "4px", marginBottom: "4px" }}>
                {Array(8).fill(null).map((_, i) => (
                  <button key={i} onClick={() => addToChain(i)} style={{
                    ...baseBtn(false, PAT_COLOR), padding: "5px 2px", fontSize: "9px", borderRadius: "4px",
                  }}>P{i + 1}</button>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: "4px" }}>
                {Array(8).fill(null).map((_, i) => (
                  <button key={i + 8} onClick={() => addToChain(i + 8)} style={{
                    ...baseBtn(false, PAT_COLOR), padding: "5px 2px", fontSize: "9px", borderRadius: "4px",
                  }}>P{i + 9}</button>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: "10px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                <div style={{ fontSize: "9px", color: "#444", letterSpacing: "2px" }}>
                  SONG CHAIN · {songChain.length} PATTERNS
                </div>
                <button onClick={clearChain} style={{ ...baseBtn(false, "#ff4444"), padding: "3px 8px", fontSize: "9px" }}>
                  CLEAR CHAIN
                </button>
              </div>
              {songChain.length === 0 ? (
                <div style={{ fontSize: "10px", color: "#2a2a2a", textAlign: "center", padding: "16px 0" }}>
                  — add patterns above to build your song —
                </div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
                  {songChain.map((patIdx, pos) => (
                    <div key={pos} style={{
                      background: pos === currentChainIdx && isPlaying && chainPlaying ? PAT_COLOR + "33" : "#1a1a1a",
                      border: `1.5px solid ${pos === currentChainIdx && isPlaying && chainPlaying ? PAT_COLOR : "#2a2a2a"}`,
                      borderRadius: "5px", padding: "4px 8px", fontSize: "10px",
                      color: pos === currentChainIdx && isPlaying && chainPlaying ? PAT_COLOR : "#555",
                      display: "flex", alignItems: "center", gap: "6px",
                    }}>
                      <span>P{patIdx + 1}</span>
                      <button onClick={() => removeFromChain(pos)} style={{
                        background: "none", border: "none", color: "#444", cursor: "pointer",
                        fontSize: "11px", padding: "0", lineHeight: 1,
                      }}>×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: "6px" }}>
              <button onClick={() => setChainPlaying(p => !p)} style={{
                ...baseBtn(chainPlaying, SEQ_COLOR), flex: 1, padding: "7px 0",
              }}>
                {chainPlaying ? "● SONG MODE ON" : "SONG MODE OFF"}
              </button>
            </div>
          </>
        )}

        {/* ── LIVE FX MATRIX (Punch-In Effects) ── */}
        <div style={{ marginBottom: "16px", marginTop: "16px", background: "#1a1014", padding: "8px", borderRadius: "8px" }}>
           <div style={{ fontSize: "9px", color: FX_COLOR, marginBottom: "6px", textAlign: "center" }}>HOLD FOR PUNCH-IN FX</div>
           <div style={{ display: "flex", gap: "6px" }}>
             {["LOWPASS", "HIGHPASS", "STUTTER", "PITCH_DOWN"].map(fx => (
               <button key={fx}
                 onPointerDown={() => setActiveFX(fx)}
                 onPointerUp={() => setActiveFX(null)}
                 onPointerLeave={() => setActiveFX(null)}
                 style={{ ...baseBtn(activeFX === fx, FX_COLOR, "#221115"), flex: 1, padding: "8px 0" }}>
                 {fx.replace("_", " ")}
               </button>
             ))}
           </div>
        </div>

        {/* ── Transport, Tempo, Key & Scale ── */}
        <div style={{ display: "flex", gap: "8px", marginBottom: "14px" }}>
          <button onClick={() => setIsPlaying(p => !p)} style={{ background: isPlaying ? "#e8441a" : "#1e1e1e", border: `1.5px solid ${isPlaying ? "#e8441a" : "#333"}`, color: "#fff", borderRadius: "7px", padding: "10px 0", flex: 2, fontFamily: "monospace", cursor: "pointer" }}>
            {isPlaying ? "■ STOP" : "▶ PLAY"}
          </button>
          <button
            onClick={() => {
              if (isRecording) stopRecording();
              else startRecording();
            }}
            style={{
              background: isRecording ? "#ff333322" : "#1e1e1e",
              border: `1.5px solid ${isRecording ? "#ff3333" : "#333"}`,
              color: isRecording ? "#ff4444" : "#888",
              borderRadius: "7px", padding: "10px 0", cursor: "pointer", flex: 1, fontFamily: "monospace"
            }}>
            {isRecording ? "◼ STOP" : "● REC"}
          </button>
        </div>

        <div style={{ display: "flex", gap: "10px", background: "#111", padding: "10px", borderRadius: "8px" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "9px", color: "#666", marginBottom: "5px" }}>BPM</div>
            <input type="range" min={40} max={240} value={bpm} onChange={e => setBpm(Number(e.target.value))} style={{ width: "100%", accentColor: "#e8441a", cursor: "pointer" }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "9px", color: "#666", marginBottom: "5px" }}>SWING</div>
            <input type="range" min={0} max={50} value={swing} onChange={e => setSwing(Number(e.target.value))} style={{ width: "100%", accentColor: SEQ_COLOR, cursor: "pointer" }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "9px", color: "#666", marginBottom: "5px" }}>KEY</div>
            <select value={keySig} onChange={e => setKeySig(Number(e.target.value))} style={{ width: "100%", background: "#1a1a1a", color: "#fff", border: "1px solid #333", borderRadius: "4px", padding: "4px", fontSize: "10px", fontFamily: "monospace", outline: "none", cursor: "pointer" }}>
              {NOTE_NAMES.map((n, i) => <option key={i} value={i}>{n}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "9px", color: "#666", marginBottom: "5px" }}>SCALE</div>
            <select value={scale} onChange={e => setScale(e.target.value)} style={{ width: "100%", background: "#1a1a1a", color: "#fff", border: "1px solid #333", borderRadius: "4px", padding: "4px", fontSize: "10px", fontFamily: "monospace", outline: "none", cursor: "pointer" }}>
              {Object.keys(SCALES).map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        {/* ── Footer ── */}
        <div style={{ textAlign: "right", marginTop: "16px", fontSize: "9px", color: "#444", letterSpacing: "2px" }}>
          © ARNAB ROY
        </div>

      </div>
    </div>
  );
}
