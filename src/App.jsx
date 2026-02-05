import { useEffect, useMemo, useRef, useState } from "react";
import dayPlans from "./data/dayPlans.json";

const STORAGE_KEY = "a2_progress_v10";

function loadProgress() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return { currentDay: 1, maxUnlockedDay: 1, mode: "learn" };
    const parsed = JSON.parse(saved);
    return {
      currentDay: parsed.currentDay ?? 1,
      maxUnlockedDay: parsed.maxUnlockedDay ?? 1,
      mode: parsed.mode ?? "learn",
    };
  } catch {
    return { currentDay: 1, maxUnlockedDay: 1, mode: "learn" };
  }
}

function saveProgress(p) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
}

function countSentences(text) {
  const parts = (text || "")
    .split(/[.!?]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length;
}

function normalize(text) {
  return (text || "").toLowerCase();
}

function includesAny(haystack, words) {
  const t = normalize(haystack);
  return (words || []).some((w) => t.includes(String(w).toLowerCase()));
}

function countVocabUsed(text, vocabList) {
  const t = normalize(text);
  let count = 0;
  for (const w of vocabList || []) {
    if (t.includes(String(w).toLowerCase())) count += 1;
  }
  return count;
}

function testRegexAll(text, patterns) {
  return (patterns || []).map((p) => {
    const re = new RegExp(p, "i");
    return re.test(text || "");
  });
}

/** Listening helpers: supports either `segments` or legacy `text+quiz` */
function getListeningSegments(dayPlan) {
  const L = dayPlan?.listening;
  if (!L) return [];
  if (Array.isArray(L.segments) && L.segments.length) return L.segments;

  // legacy fallback
  if (L.text) {
    return [
      {
        id: 1,
        title: "Listening",
        text: L.text,
        repeat: 1,
        quiz: Array.isArray(L.quiz) ? L.quiz : [],
      },
    ];
  }
  return [];
}

function flattenListeningQuiz(dayPlan) {
  const segs = getListeningSegments(dayPlan);
  const out = [];
  segs.forEach((seg, segIndex) => {
    (seg.quiz || []).forEach((q, qIndex) => {
      out.push({
        segIndex,
        qIndex,
        q,
        key: `${segIndex}-${qIndex}`,
      });
    });
  });
  return out;
}

function buildTranscript(dayPlan) {
  const segs = getListeningSegments(dayPlan);
  return segs.map((s) => `# ${s.title}\n${s.text}`).join("\n\n");
}

/** iOS often doesn't stop reliably unless we do a "hard stop" */
function iosHardStop() {
  const synth = window.speechSynthesis;

  // Pause first (helps on iOS)
  try {
    synth.pause();
  } catch {}

  // Cancel current + queued
  try {
    synth.cancel();
  } catch {}

  // Flush trick: tiny utterance then cancel again
  try {
    const flush = new SpeechSynthesisUtterance("");
    flush.lang = "de-DE";
    flush.rate = 1;

    flush.onend = () => {
      try {
        synth.cancel();
      } catch {}
    };

    synth.speak(flush);

    setTimeout(() => {
      try {
        synth.cancel();
      } catch {}
    }, 50);
  } catch {}
}

export default function App() {
  const [progress, setProgress] = useState(loadProgress());

  const safeDay = Math.min(progress.currentDay, progress.maxUnlockedDay);
  const dayPlan = useMemo(
    () => dayPlans.find((d) => d.day === safeDay),
    [safeDay]
  );

  const mode = progress.mode; // "learn" | "quiz"

  // Vocab quiz
  const [vocabCorrect, setVocabCorrect] = useState(0);
  const [vocabChosen, setVocabChosen] = useState({});

  // Grammar quiz
  const [grammarCorrect, setGrammarCorrect] = useState(0);
  const [grammarChosen, setGrammarChosen] = useState({});

  // Listening quiz (flattened)
  const [listeningCorrect, setListeningCorrect] = useState(0);
  const [listeningChosen, setListeningChosen] = useState({});

  // TTS
  const [ttsSupported, setTtsSupported] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const utterQueueRef = useRef([]);
  const currentUtterRef = useRef(null);

  // Stop token: guarantees your queue does not continue after Stop on iOS
  const stopTokenRef = useRef(0);

  // Voice controls
  const [voices, setVoices] = useState([]);
  const [voiceURI, setVoiceURI] = useState("");
  const [rate, setRate] = useState(0.95);
  const [pitch, setPitch] = useState(1.0);

  // Output
  const [outputText, setOutputText] = useState("");
  const [outputReport, setOutputReport] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => saveProgress(progress), [progress]);

  useEffect(() => {
    const ok = typeof window !== "undefined" && "speechSynthesis" in window;
    setTtsSupported(ok);

    if (!ok) return;

    const loadVoices = () => {
      const vs = window.speechSynthesis.getVoices() || [];
      setVoices(vs);

      // default: prefer German voice
      if (!voiceURI) {
        const de =
          vs.find((v) => (v.lang || "").toLowerCase().startsWith("de")) ||
          vs[0];
        if (de) setVoiceURI(de.voiceURI);
      }
    };

    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;

    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedVoice = useMemo(() => {
    return voices.find((v) => v.voiceURI === voiceURI) || null;
  }, [voices, voiceURI]);

  // Reset states when day changes
  useEffect(() => {
    setVocabCorrect(0);
    setVocabChosen({});
    setGrammarCorrect(0);
    setGrammarChosen({});
    setListeningCorrect(0);
    setListeningChosen({});
    setOutputText("");
    setOutputReport(null);
    setResult(null);

    // stop any current speech
    try {
      if ("speechSynthesis" in window) {
        stopTokenRef.current += 1;
        iosHardStop();
      }
    } catch {}
    setIsSpeaking(false);
    utterQueueRef.current = [];
    currentUtterRef.current = null;
  }, [safeDay]);

  if (!dayPlan) {
    return (
      <div style={{ maxWidth: 860, margin: "40px auto", fontFamily: "sans-serif" }}>
        <h1>🎉 Completed!</h1>
        <p>No day found for Day {safeDay}. Add more days in dayPlans.json.</p>
        <button
          onClick={() => {
            localStorage.removeItem(STORAGE_KEY);
            setProgress({ currentDay: 1, maxUnlockedDay: 1, mode: "learn" });
          }}
        >
          Reset progress
        </button>
      </div>
    );
  }

  const listeningSegments = getListeningSegments(dayPlan);
  const listeningQuizFlat = flattenListeningQuiz(dayPlan);
  const transcript = buildTranscript(dayPlan);

  function setMode(newMode) {
    setProgress((p) => ({ ...p, mode: newMode }));
  }

  function goToDay(day) {
    if (day < 1) return;
    if (day > progress.maxUnlockedDay) return;
    setProgress((p) => ({ ...p, currentDay: day, mode: "learn" }));
  }

  function stopSpeaking() {
    // invalidate any in-flight queue loop
    stopTokenRef.current += 1;

    if (!ttsSupported) {
      setIsSpeaking(false);
      utterQueueRef.current = [];
      currentUtterRef.current = null;
      return;
    }

    try {
      iosHardStop();
    } catch {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }

    setIsSpeaking(false);
    utterQueueRef.current = [];
    currentUtterRef.current = null;
  }

  function speakTextsAsQueue(texts) {
    if (!ttsSupported) return;

    // stop any current speech and invalidate older queue loops
    stopSpeaking();

    const queue = texts.filter((t) => String(t || "").trim().length > 0);
    if (!queue.length) return;

    utterQueueRef.current = queue;

    const myToken = stopTokenRef.current;

    const speakNext = () => {
      // Stop pressed? exit immediately
      if (stopTokenRef.current !== myToken) {
        setIsSpeaking(false);
        currentUtterRef.current = null;
        return;
      }

      const next = utterQueueRef.current.shift();
      if (!next) {
        setIsSpeaking(false);
        currentUtterRef.current = null;
        return;
      }

      const u = new SpeechSynthesisUtterance(next);

      // voice settings
      if (selectedVoice) u.voice = selectedVoice;
      u.lang = selectedVoice?.lang || "de-DE";
      u.rate = Math.max(0.6, Math.min(1.4, Number(rate) || 1));
      u.pitch = Math.max(0.6, Math.min(1.4, Number(pitch) || 1));

      u.onstart = () => setIsSpeaking(true);

      u.onend = () => {
        if (stopTokenRef.current !== myToken) return;
        speakNext();
      };

      u.onerror = () => {
        if (stopTokenRef.current !== myToken) return;
        speakNext();
      };

      currentUtterRef.current = u;

      try {
        window.speechSynthesis.speak(u);
      } catch {
        speakNext();
      }
    };

    speakNext();
  }

  function speakAllListening() {
    // 10-min listening = 5 segments, each repeated (repeat times)
    const texts = [];
    listeningSegments.forEach((seg) => {
      const rep = Math.max(1, Number(seg.repeat || 1));
      for (let r = 0; r < rep; r++) texts.push(seg.text);
    });
    speakTextsAsQueue(texts);
  }

  function speakOneSegment(segIndex) {
    const seg = listeningSegments[segIndex];
    if (!seg) return;
    const rep = Math.max(1, Number(seg.repeat || 1));
    const texts = [];
    for (let r = 0; r < rep; r++) texts.push(seg.text);
    speakTextsAsQueue(texts);
  }

  function evaluateOutput() {
    const rules = dayPlan.outputRules;
    const t = outputText || "";

    const charCount = t.trim().length;
    const sentences = countSentences(t);

    const hasAnyKeywords = includesAny(t, rules.mustIncludeAny || []);
    const patternChecks = testRegexAll(t, rules.mustIncludeAllPatterns || []);
    const patternsOk = patternChecks.every(Boolean);

    const todaysVocabList = (dayPlan.vocab_list || []).map((x) => x.de);
    const vocabUsedCount = countVocabUsed(t, todaysVocabList);

    const report = {
      charCount,
      minChars: dayPlan.passRules.minOutputChars,
      charsOk: charCount >= dayPlan.passRules.minOutputChars,

      sentences,
      minSentences: rules.minSentences,
      sentencesOk: sentences >= rules.minSentences,

      mustIncludeAny: rules.mustIncludeAny || [],
      keywordOk: (rules.mustIncludeAny || []).length === 0 ? true : hasAnyKeywords,

      mustIncludeAllPatterns: rules.mustIncludeAllPatterns || [],
      patternChecks,
      patternsOk,

      vocabUsedCount,
      mustUseVocabAtLeast: rules.mustUseVocabAtLeast,
      vocabOk: vocabUsedCount >= rules.mustUseVocabAtLeast,
    };

    setOutputReport(report);

    return (
      report.charsOk &&
      report.sentencesOk &&
      report.keywordOk &&
      report.patternsOk &&
      report.vocabOk
    );
  }

  function checkPassAndUnlock() {
    const vocabScore = dayPlan.vocab_quiz?.length
      ? vocabCorrect / dayPlan.vocab_quiz.length
      : 1;
    const grammarScore = dayPlan.grammar?.quiz?.length
      ? grammarCorrect / dayPlan.grammar.quiz.length
      : 1;
    const listeningScore = listeningQuizFlat.length
      ? listeningCorrect / listeningQuizFlat.length
      : 1;

    const outputOk = evaluateOutput();

    const passed =
      vocabScore >= dayPlan.passRules.vocabMinCorrect &&
      grammarScore >= dayPlan.passRules.grammarMinCorrect &&
      listeningScore >= dayPlan.passRules.listeningMinCorrect &&
      outputOk;

    setResult({ vocabScore, grammarScore, listeningScore, outputOk, passed });

    if (passed) {
      const nextDay = safeDay + 1;
      setProgress((p) => ({
        ...p,
        maxUnlockedDay: Math.max(p.maxUnlockedDay, nextDay),
        currentDay: nextDay,
        mode: "learn",
      }));
    }
  }

  const showTranscript = Object.keys(listeningChosen).length > 0;

  return (
    <div style={{ maxWidth: 860, margin: "30px auto", fontFamily: "sans-serif" }}>
      {/* TOP BAR */}
      <div
        style={{
          padding: 12,
          border: "1px solid #333",
          borderRadius: 14,
          marginBottom: 18,
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div>
          <div style={{ fontSize: 20, fontWeight: 800 }}>
            Day {safeDay}: {dayPlan.topic}
          </div>
          <div style={{ opacity: 0.8 }}>
            Unlocked up to Day <b>{progress.maxUnlockedDay}</b>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={() => setMode("learn")}
            style={{
              padding: "8px 12px",
              borderRadius: 12,
              fontWeight: 700,
              opacity: mode === "learn" ? 1 : 0.7,
            }}
          >
            📖 Learn
          </button>
          <button
            onClick={() => setMode("quiz")}
            style={{
              padding: "8px 12px",
              borderRadius: 12,
              fontWeight: 700,
              opacity: mode === "quiz" ? 1 : 0.7,
            }}
          >
            ✅ Quiz
          </button>
        </div>
      </div>

      {/* TTS SETTINGS */}
      <div style={{ padding: 12, border: "1px solid #444", borderRadius: 12, marginBottom: 18 }}>
        <b>🔊 TTS Settings</b>
        {!ttsSupported ? (
          <div style={{ color: "salmon", marginTop: 8 }}>
            Text-to-speech not supported. Use Chrome/Edge.
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 10 }}>
            <div>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Voice</div>
              <select
                value={voiceURI}
                onChange={(e) => {
                  stopSpeaking();
                  setVoiceURI(e.target.value);
                }}
                style={{ width: "100%", padding: 8, borderRadius: 10 }}
              >
                {voices.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Rate: {Number(rate).toFixed(2)}</div>
              <input
                type="range"
                min="0.6"
                max="1.4"
                step="0.05"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                style={{ width: "100%" }}
              />
            </div>

            <div>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Pitch: {Number(pitch).toFixed(2)}</div>
              <input
                type="range"
                min="0.6"
                max="1.4"
                step="0.05"
                value={pitch}
                onChange={(e) => setPitch(e.target.value)}
                style={{ width: "100%" }}
              />
            </div>
          </div>
        )}
      </div>

      {/* DAY NAV */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
        <button
          onClick={() => goToDay(safeDay - 1)}
          disabled={safeDay <= 1}
          style={{ padding: "8px 12px", borderRadius: 12 }}
        >
          ← Previous
        </button>

        <button
          onClick={() => goToDay(safeDay + 1)}
          disabled={safeDay + 1 > progress.maxUnlockedDay}
          style={{ padding: "8px 12px", borderRadius: 12 }}
        >
          Next →
        </button>

        <button
          onClick={() => {
            if (confirm("Reset progress back to Day 1?")) {
              localStorage.removeItem(STORAGE_KEY);
              setProgress({ currentDay: 1, maxUnlockedDay: 1, mode: "learn" });
            }
          }}
          style={{ padding: "8px 12px", borderRadius: 12, opacity: 0.8 }}
        >
          Reset
        </button>
      </div>

      {/* ===================== LEARN PAGE ===================== */}
      {mode === "learn" && (
        <>
          {/* VOCAB LIST */}
          <h2>📚 Vocabulary List (30)</h2>
          <div style={{ padding: 12, border: "1px solid #444", borderRadius: 12 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {dayPlan.vocab_list.map((v, idx) => (
                <div
                  key={idx}
                  style={{ padding: "6px 10px", borderRadius: 10, border: "1px solid #333" }}
                  title={v.en}
                >
                  <b>{v.de}</b> — <span style={{ opacity: 0.85 }}>{v.en}</span>
                </div>
              ))}
            </div>
          </div>

          {/* GRAMMAR RULES */}
          <h2 style={{ marginTop: 18 }}>📗 Grammar</h2>
          <p>
            <b>{dayPlan.grammar.title}</b>
          </p>

          <div style={{ padding: 12, border: "1px solid #444", borderRadius: 12 }}>
            <p style={{ marginTop: 0, marginBottom: 8 }}>
              <b>Rules (5)</b>
            </p>
            <ol style={{ marginTop: 0 }}>
              {dayPlan.grammar.rules.map((r, idx) => (
                <li key={idx}>{r}</li>
              ))}
            </ol>

            <p style={{ marginBottom: 6, marginTop: 12 }}>
              <b>Examples</b>
            </p>
            <ul style={{ marginTop: 0 }}>
              {dayPlan.grammar.examples.map((ex, idx) => (
                <li key={idx}>{ex}</li>
              ))}
            </ul>
          </div>

          {/* LISTENING PRACTICE (10 min) */}
          <h2 style={{ marginTop: 18 }}>🎧 Listening Practice (≈10 minutes)</h2>
          <p style={{ opacity: 0.85 }}>
            Structure: 5 segments × repeat twice. Listen fully first, then go to Quiz.
          </p>

          {ttsSupported ? (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
              {!isSpeaking ? (
                <button onClick={speakAllListening} style={{ padding: "8px 12px", borderRadius: 10 }}>
                  ▶ Play full 10-min listening
                </button>
              ) : (
                <button onClick={stopSpeaking} style={{ padding: "8px 12px", borderRadius: 10 }}>
                  ⏹ Stop
                </button>
              )}
            </div>
          ) : (
            <p style={{ color: "salmon" }}>Text-to-speech not supported. Use Chrome/Edge.</p>
          )}

          <div style={{ display: "grid", gap: 10 }}>
            {listeningSegments.map((seg, idx) => (
              <div key={idx} style={{ padding: 12, border: "1px solid #444", borderRadius: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <div>
                    <b>Segment {idx + 1}:</b> {seg.title}{" "}
                    <span style={{ opacity: 0.7 }}>(repeat ×{seg.repeat || 1})</span>
                  </div>
                  {ttsSupported && (
                    <button
                      onClick={() => speakOneSegment(idx)}
                      disabled={isSpeaking}
                      style={{ padding: "6px 10px", borderRadius: 10, opacity: isSpeaking ? 0.6 : 1 }}
                    >
                      ▶ Play segment
                    </button>
                  )}
                </div>
                <div style={{ marginTop: 8, opacity: 0.85 }}>
                  Transcript hidden here (appears in Quiz after you answer at least 1 question).
                </div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 22 }}>
            <button onClick={() => setMode("quiz")} style={{ padding: "10px 14px", borderRadius: 12, fontWeight: 800 }}>
              ✅ Start Quiz
            </button>
          </div>
        </>
      )}

      {/* ===================== QUIZ PAGE ===================== */}
      {mode === "quiz" && (
        <>
          {/* VOCAB QUIZ */}
          <h2>📘 Vocabulary Quiz</h2>
          <p style={{ opacity: 0.85 }}>
            Correct: {vocabCorrect} / {dayPlan.vocab_quiz.length}
          </p>

          {dayPlan.vocab_quiz.map((q, i) => {
            const chosen = vocabChosen[i];
            const locked = chosen !== undefined;
            const isCorrect = locked && chosen === q.answer;

            return (
              <div key={i} style={{ marginBottom: 14, padding: 12, border: "1px solid #444", borderRadius: 12 }}>
                <p style={{ marginTop: 0 }}>
                  <b>{q.word}</b>
                </p>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {q.choices.map((c) => (
                    <button
                      key={c}
                      disabled={locked}
                      onClick={() => {
                        setVocabChosen((prev) => ({ ...prev, [i]: c }));
                        if (c === q.answer) setVocabCorrect((v) => v + 1);
                      }}
                      style={{ padding: "6px 10px", borderRadius: 10, opacity: locked ? 0.65 : 1 }}
                    >
                      {c}
                    </button>
                  ))}
                </div>

                {locked && (
                  <p style={{ marginBottom: 0, marginTop: 10 }}>
                    {isCorrect ? (
                      <span style={{ color: "lightgreen" }}>✅ Correct</span>
                    ) : (
                      <span style={{ color: "salmon" }}>
                        ❌ Wrong — correct answer: <b>{q.answer}</b>
                      </span>
                    )}
                  </p>
                )}
              </div>
            );
          })}

          {/* GRAMMAR QUIZ */}
          <h2>📗 Grammar Quiz</h2>
          <p style={{ opacity: 0.85 }}>
            Correct: {grammarCorrect} / {dayPlan.grammar.quiz.length}
          </p>

          {dayPlan.grammar.quiz.map((q, i) => {
            const chosen = grammarChosen[i];
            const locked = chosen !== undefined;
            const isCorrect = locked && chosen === q.a;

            return (
              <div key={i} style={{ marginBottom: 14, padding: 12, border: "1px solid #444", borderRadius: 12 }}>
                <p style={{ marginTop: 0 }}>{q.q}</p>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {q.choices.map((c) => (
                    <button
                      key={c}
                      disabled={locked}
                      onClick={() => {
                        setGrammarChosen((prev) => ({ ...prev, [i]: c }));
                        if (c === q.a) setGrammarCorrect((g) => g + 1);
                      }}
                      style={{ padding: "6px 10px", borderRadius: 10, opacity: locked ? 0.65 : 1 }}
                    >
                      {c}
                    </button>
                  ))}
                </div>

                {locked && (
                  <p style={{ marginBottom: 0, marginTop: 10 }}>
                    {isCorrect ? (
                      <span style={{ color: "lightgreen" }}>✅ Correct</span>
                    ) : (
                      <span style={{ color: "salmon" }}>
                        ❌ Wrong — correct answer: <b>{q.a}</b>
                      </span>
                    )}
                  </p>
                )}
              </div>
            );
          })}

          {/* LISTENING QUIZ */}
          <h2>🎧 Listening Quiz (based on the 10-min audio)</h2>
          <p style={{ opacity: 0.85 }}>
            Correct: {listeningCorrect} / {listeningQuizFlat.length}
          </p>

          {ttsSupported ? (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
              {!isSpeaking ? (
                <button onClick={speakAllListening} style={{ padding: "8px 12px", borderRadius: 10 }}>
                  ▶ Play full listening again
                </button>
              ) : (
                <button onClick={stopSpeaking} style={{ padding: "8px 12px", borderRadius: 10 }}>
                  ⏹ Stop
                </button>
              )}
            </div>
          ) : (
            <p style={{ color: "salmon" }}>Text-to-speech not supported. Use Chrome/Edge.</p>
          )}

          {listeningQuizFlat.map((item, idx) => {
            const q = item.q;
            const chosen = listeningChosen[item.key];
            const locked = chosen !== undefined;
            const isCorrect = locked && chosen === q.a;

            return (
              <div key={item.key} style={{ marginBottom: 14, padding: 12, border: "1px solid #444", borderRadius: 12 }}>
                <p style={{ marginTop: 0 }}>
                  <b>Q{idx + 1}.</b> {q.q}
                </p>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {q.choices.map((c) => (
                    <button
                      key={c}
                      disabled={locked}
                      onClick={() => {
                        setListeningChosen((prev) => ({ ...prev, [item.key]: c }));
                        if (c === q.a) setListeningCorrect((l) => l + 1);
                      }}
                      style={{ padding: "6px 10px", borderRadius: 10, opacity: locked ? 0.65 : 1 }}
                    >
                      {c}
                    </button>
                  ))}
                </div>

                {locked && (
                  <p style={{ marginBottom: 0, marginTop: 10 }}>
                    {isCorrect ? (
                      <span style={{ color: "lightgreen" }}>✅ Correct</span>
                    ) : (
                      <span style={{ color: "salmon" }}>
                        ❌ Wrong — correct answer: <b>{q.a}</b>
                      </span>
                    )}
                  </p>
                )}
              </div>
            );
          })}

          <div style={{ marginTop: 10 }}>
            <h3>📝 Transcript</h3>
            {!showTranscript ? (
              <p style={{ opacity: 0.8 }}>Transcript appears after you answer at least 1 listening question.</p>
            ) : (
              <div style={{ padding: 12, border: "1px solid #444", borderRadius: 12, whiteSpace: "pre-wrap" }}>
                {transcript}
              </div>
            )}
          </div>

          {/* OUTPUT */}
          <h2 style={{ marginTop: 22 }}>✍️ Output</h2>
          <p>{dayPlan.output.prompt}</p>

          <textarea
            rows={7}
            style={{ width: "100%", padding: 10, borderRadius: 10 }}
            value={outputText}
            onChange={(e) => setOutputText(e.target.value)}
            placeholder="Write here..."
          />

          <button onClick={() => evaluateOutput()} style={{ marginTop: 8, padding: "8px 12px", borderRadius: 10 }}>
            🔍 Check writing rules
          </button>

          {outputReport && (
            <div style={{ marginTop: 12, padding: 12, border: "1px solid #444", borderRadius: 12 }}>
              <h3 style={{ marginTop: 0 }}>Writing checklist</h3>
              <ul style={{ margin: 0 }}>
                <li>
                  Characters: {outputReport.charCount}/{outputReport.minChars} {outputReport.charsOk ? "✅" : "❌"}
                </li>
                <li>
                  Sentences: {outputReport.sentences}/{outputReport.minSentences} {outputReport.sentencesOk ? "✅" : "❌"}
                </li>
                <li>
                  Must include any of: {outputReport.mustIncludeAny.join(", ")} {outputReport.keywordOk ? "✅" : "❌"}
                </li>
                <li>
                  Required patterns:{" "}
                  {outputReport.mustIncludeAllPatterns.map((p, idx) => (
                    <span key={p}>
                      <code>{p}</code> {outputReport.patternChecks[idx] ? "✅" : "❌"}{" "}
                    </span>
                  ))}
                </li>
                <li>
                  Used today’s vocab: {outputReport.vocabUsedCount}/{outputReport.mustUseVocabAtLeast}{" "}
                  {outputReport.vocabOk ? "✅" : "❌"}
                </li>
              </ul>
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <button onClick={checkPassAndUnlock} style={{ padding: "10px 14px", borderRadius: 12, fontWeight: 800 }}>
              ✅ Check & Unlock Next Day
            </button>
          </div>

          {result && (
            <div style={{ marginTop: 18, padding: 12, border: "1px solid #444", borderRadius: 12 }}>
              <h3 style={{ marginTop: 0 }}>{result.passed ? "✅ PASSED" : "❌ NOT PASSED"}</h3>
              <ul style={{ margin: 0 }}>
                <li>Vocab quiz score: {(result.vocabScore * 100).toFixed(0)}%</li>
                <li>Grammar quiz score: {(result.grammarScore * 100).toFixed(0)}%</li>
                <li>Listening quiz score: {(result.listeningScore * 100).toFixed(0)}%</li>
                <li>Output rules: {result.outputOk ? "Passed" : "Failed"}</li>
              </ul>
              {!result.passed && (
                <p style={{ marginTop: 10, opacity: 0.85 }}>
                  Fix failed parts and try again. Next day stays locked until passed.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
