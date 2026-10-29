/**
 * 图片生成页（照官方 0.1.52 WebUI 的 Images 页）。
 *
 * 后端能力在 Strata 引擎的 `serve/images.py`：`POST /v1/images/generations`，
 * 由引擎拉起 `sd-cli` 跑一次生成（配置里的 `images` 段指向 sd-cli 与扩散模型）。
 * llama.cpp 没有这个端点，所以本页只在 Strata 引擎运行时可提交。
 */
import { useState } from "react";

import { generateImages, type GeneratedImage } from "../api/strata";
import { useApp } from "../store";

const SIZES = ["", "512x512", "768x768", "1024x1024", "832x1216", "1216x832"];

export function ImagesPage() {
  const enginePort = useApp((state) => state.strataStatus.port);
  const loaded = useApp((state) => state.strataStatus.loaded);
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState("");
  const [count, setCount] = useState(1);
  const [steps, setSteps] = useState(8);
  const [seed, setSeed] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [images, setImages] = useState<GeneratedImage[]>([]);

  const ready = Boolean(enginePort && loaded);

  const submit = async () => {
    if (!enginePort) return;
    const text = prompt.trim();
    if (!text) {
      setError("先写一段提示词");
      return;
    }
    const parsedSeed = seed.trim() === "" ? null : Number(seed);
    if (parsedSeed !== null && (!Number.isSafeInteger(parsedSeed) || parsedSeed < 0)) {
      setError("种子要填非负整数，或者留空");
      return;
    }
    setBusy(true);
    setError("");
    try {
      setImages(await generateImages(enginePort, { prompt: text, size, n: count, steps, seed: parsedSeed }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="main-area">
      <div className="top-bar">
        <h1 className="page-title">图片生成</h1>
        <div className="top-actions">
          <span className="muted small">
            Strata 引擎跑 sd-cli 生成图片；需要运行配置里有 images 段（setup --images 装好的 sd-cli 与扩散模型）
          </span>
        </div>
      </div>

      <section className="st-card">
        {!ready ? (
          <p className="st-hint">
            {enginePort ? "先加载一个 Strata 模型再生成 —— 引擎没在跑。" : "Strata 引擎没在运行，生图端点连不上。"}
          </p>
        ) : (
          <>
            <label className="st-label" htmlFor="images-prompt">
              提示词
            </label>
            <textarea
              id="images-prompt"
              className="st-input images-prompt"
              rows={3}
              value={prompt}
              placeholder="描述画面，例如：一只橘猫趴在窗台上，午后阳光，摄影质感"
              onChange={(event) => setPrompt(event.target.value)}
            />
            <div className="images-row">
              <label className="st-field">
                <span className="st-label">尺寸</span>
                <select className="st-input" value={size} onChange={(event) => setSize(event.target.value)}>
                  {SIZES.map((item) => (
                    <option key={item || "auto"} value={item}>
                      {item || "引擎默认"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="st-field">
                <span className="st-label">张数</span>
                <input
                  className="st-input"
                  type="number"
                  min={1}
                  max={4}
                  value={count}
                  onChange={(event) => setCount(Math.max(1, Math.min(4, Number(event.target.value) || 1)))}
                />
              </label>
              <label className="st-field">
                <span className="st-label">步数</span>
                <input
                  className="st-input"
                  type="number"
                  min={1}
                  max={100}
                  value={steps}
                  onChange={(event) => setSteps(Math.max(1, Math.min(100, Number(event.target.value) || 1)))}
                />
              </label>
              <label className="st-field">
                <span className="st-label">种子</span>
                <input
                  className="st-input"
                  type="number"
                  min={0}
                  placeholder="随机"
                  value={seed}
                  onChange={(event) => setSeed(event.target.value)}
                />
              </label>
            </div>
            <div className="images-actions">
              <button type="button" className="st-btn st-btn--primary" disabled={busy} onClick={() => void submit()}>
                {busy ? "生成中…" : "生成"}
              </button>
              {error ? <span className="chat-advanced__error">{error}</span> : null}
            </div>
            {images.length > 0 && (
              <div className="images-grid">
                {images.map((image, index) => (
                  <figure key={`${index}-${image.src.slice(-16)}`} className="images-item">
                    <img src={image.src} alt={`生成结果 ${index + 1}`} />
                    <figcaption>
                      <a className="st-btn st-btn--secondary" href={image.src} download={`image-${index + 1}.png`}>
                        保存
                      </a>
                      {image.revisedPrompt ? <span className="muted small">{image.revisedPrompt}</span> : null}
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
