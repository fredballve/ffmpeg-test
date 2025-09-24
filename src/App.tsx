import React, { useEffect, useRef, useState } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL, fetchFile } from "@ffmpeg/util";
import "./App.css";

export default function App() {
    const ffmpegRef = useRef(new FFmpeg());
    const [ffmpegReady, setFfmpegReady] = useState(false);

    const [hookFiles, setHookFiles] = useState([]);
    const [bodyFiles, setBodyFiles] = useState([]);
    const [ctaFiles, setCtaFiles] = useState([]);

    const [logs, setLogs] = useState([]);
    const [progressPct, setProgressPct] = useState(0);
    const [isProcessing, setIsProcessing] = useState(false);
    const [isZipping, setIsZipping] = useState(false);
    const [downloadUrls, setDownloadUrls] = useState([]);
    const [currentCombo, setCurrentCombo] = useState("");
    const [totalCombos, setTotalCombos] = useState(0);

    // Load ffmpeg.wasm core
    useEffect(() => {
        const load = async () => {
            const ffmpeg = ffmpegRef.current;
            ffmpeg.on("log", ({ message }) => setLogs((l) => [...l, message]));

            const baseURL =
                "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";

            await ffmpeg.load({
                coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
                wasmURL: await toBlobURL(
                    `${baseURL}/ffmpeg-core.wasm`,
                    "application/wasm"
                ),
                workerURL: await toBlobURL(
                    `${baseURL}/ffmpeg-core.worker.js`,
                    "text/javascript"
                ),
            });

            setFfmpegReady(true);
            setLogs((l) => [...l, "FFmpeg loaded."]);
        };

        load().catch((e) => {
            console.error(e);
            setLogs((l) => [...l, "Failed to load FFmpeg core.", String(e)]);
        });
    }, []);

    const handleFileSelect = (e, category) => {
        const files = Array.from(e.target.files || []).slice(0, 3); // Max 3 files
        switch (category) {
            case "hook":
                setHookFiles(files);
                break;
            case "body":
                setBodyFiles(files);
                break;
            case "cta":
                setCtaFiles(files);
                break;
            default:
                break;
        }
    };

    const removeFile = (category, index) => {
        switch (category) {
            case "hook":
                setHookFiles((prev) => prev.filter((_, i) => i !== index));
                break;
            case "body":
                setBodyFiles((prev) => prev.filter((_, i) => i !== index));
                break;
            case "cta":
                setCtaFiles((prev) => prev.filter((_, i) => i !== index));
                break;
            default:
                break;
        }
    };

    const canGenerate =
        ffmpegReady &&
        hookFiles.length > 0 &&
        bodyFiles.length > 0 &&
        ctaFiles.length > 0 &&
        !isProcessing;

    const handleGenerate = async () => {
        setIsProcessing(true);
        // Revoke any old blob urls before clearing
        downloadUrls.forEach((item) => URL.revokeObjectURL(item.url));
        setDownloadUrls([]);
        setProgressPct(0);
        setLogs([]);
        setCurrentCombo("");

        const ffmpeg = ffmpegRef.current;
        const results = [];
        const combinations = [];

        // Generate all combinations
        for (let h = 0; h < hookFiles.length; h++) {
            for (let b = 0; b < bodyFiles.length; b++) {
                for (let c = 0; c < ctaFiles.length; c++) {
                    combinations.push({
                        hook: { file: hookFiles[h], index: h },
                        body: { file: bodyFiles[b], index: b },
                        cta: { file: ctaFiles[c], index: c },
                    });
                }
            }
        }

        setTotalCombos(combinations.length);
        setLogs((l) => [
            ...l,
            `Generating ${combinations.length} video combinations...`,
        ]);

        try {
            // Write all source files to FFmpeg FS once
            for (let i = 0; i < hookFiles.length; i++) {
                await ffmpeg.writeFile(`hook_${i}.mp4`, await fetchFile(hookFiles[i]));
            }
            for (let i = 0; i < bodyFiles.length; i++) {
                await ffmpeg.writeFile(`body_${i}.mp4`, await fetchFile(bodyFiles[i]));
            }
            for (let i = 0; i < ctaFiles.length; i++) {
                await ffmpeg.writeFile(`cta_${i}.mp4`, await fetchFile(ctaFiles[i]));
            }

            // Process each combination
            for (let i = 0; i < combinations.length; i++) {
                const combo = combinations[i];
                const outputName = `output_h${combo.hook.index + 1}_b${
                    combo.body.index + 1
                }_c${combo.cta.index + 1}.mp4`;

                setCurrentCombo(
                    `Processing ${outputName} (${i + 1}/${combinations.length})`
                );
                setProgressPct(Math.round((i / combinations.length) * 100));

                const hookPath = `hook_${combo.hook.index}.mp4`;
                const bodyPath = `body_${combo.body.index}.mp4`;
                const ctaPath = `cta_${combo.cta.index}.mp4`;

                // Try fast concat first
                const concatList = `file '${hookPath}'\nfile '${bodyPath}'\nfile '${ctaPath}'\n`;
                await ffmpeg.writeFile("list.txt", concatList);

                try {
                    await ffmpeg.exec([
                        "-f",
                        "concat",
                        "-safe",
                        "0",
                        "-i",
                        "list.txt",
                        "-c",
                        "copy",
                        outputName,
                    ]);
                } catch (fastErr) {
                    // Fallback to re-encode
                    setLogs((l) => [...l, `Re-encoding ${outputName}...`]);

                    await ffmpeg.exec([
                        "-i",
                        hookPath,
                        "-i",
                        bodyPath,
                        "-i",
                        ctaPath,
                        "-filter_complex",
                        "[0:v]setsar=1[v0];[1:v]setsar=1[v1];[2:v]setsar=1[v2];" +
                        "[0:a]aresample=async=1[a0];[1:a]aresample=async=1[a1];[2:a]aresample=async=1[a2];" +
                        "[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[v][a]",
                        "-map",
                        "[v]",
                        "-map",
                        "[a]",
                        "-r",
                        "30",
                        "-c:v",
                        "mpeg4",
                        "-qscale:v",
                        "2",
                        "-c:a",
                        "aac",
                        "-b:a",
                        "128k",
                        outputName,
                    ]);
                }

                // Read result and create blob URL
                const data = await ffmpeg.readFile(outputName); // Uint8Array
                const blob = new Blob([data.buffer], { type: "video/mp4" });
                const url = URL.createObjectURL(blob);

                results.push({
                    url,
                    name: outputName,
                    hookName: combo.hook.file.name,
                    bodyName: combo.body.file.name,
                    ctaName: combo.cta.file.name,
                });

                // Clean up the output file to save memory
                await ffmpeg.deleteFile(outputName);
            }

            setDownloadUrls(results);
            setLogs((l) => [...l, `✅ Done! Generated ${results.length} videos.`]);
            setCurrentCombo("");
            setProgressPct(100);
        } catch (err) {
            console.error(err);
            setLogs((l) => [...l, "❌ Error during processing:", String(err)]);
        } finally {
            setIsProcessing(false);
        }
    };

    const downloadAll = async () => {
        if (downloadUrls.length === 0) return;

        // Single file → download directly
        if (downloadUrls.length === 1) {
            const { url, name } = downloadUrls[0];
            const a = document.createElement("a");
            a.href = url;
            a.download = name;
            a.click();
            return;
        }

        // Multiple files → zip into one
        try {
            setIsZipping(true);
            setLogs((l) => [...l, `Zipping ${downloadUrls.length} videos...`]);
            setCurrentCombo(`Zipping… 0%`);
            setProgressPct(0);

            const JSZip = (await import("jszip")).default;
            const zip = new JSZip();

            // mp4 is already compressed; use STORE for speed/memory
            for (const item of downloadUrls) {
                const blob = await fetch(item.url).then((r) => r.blob());
                zip.file(item.name, blob, { binary: true });
            }

            const zipBlob = await zip.generateAsync(
                { type: "blob", compression: "STORE" },
                (meta) => {
                    const pct = Math.round(meta.percent);
                    setProgressPct(pct);
                    setCurrentCombo(`Zipping… ${pct}%`);
                }
            );

            const zipUrl = URL.createObjectURL(zipBlob);
            const a = document.createElement("a");
            a.href = zipUrl;
            a.download = `videos_${downloadUrls.length}.zip`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(zipUrl), 2000);

            setCurrentCombo("");
            setLogs((l) => [...l, "✅ ZIP ready."]);
        } catch (e) {
            setLogs((l) => [
                ...l,
                "❌ Failed to zip. Falling back to individual downloads.",
                String(e),
            ]);
            // Fallback: individual downloads
            downloadUrls.forEach((item, index) => {
                setTimeout(() => {
                    const a = document.createElement("a");
                    a.href = item.url;
                    a.download = item.name;
                    a.click();
                }, index * 200);
            });
        } finally {
            setIsZipping(false);
        }
    };

    const resetAll = () => {
        // Revoke blob URLs to free memory
        downloadUrls.forEach((item) => URL.revokeObjectURL(item.url));
        setHookFiles([]);
        setBodyFiles([]);
        setCtaFiles([]);
        setDownloadUrls([]);
        setProgressPct(0);
        setLogs([]);
        setCurrentCombo("");
        setTotalCombos(0);
    };

    const UploadCard = ({ files, category, label, hint }) => (
        <div className="card upload-card">
            <div className="card-header">
                <span className="card-title">{label}</span>
                <span className="badge">{files.length}/3</span>
            </div>

            <label className="dropzone">
                <input
                    type="file"
                    accept="video/mp4"
                    multiple
                    onChange={(e) => handleFileSelect(e, category)}
                    disabled={isProcessing || isZipping}
                />
                <div className="dropzone-inner">
                    <div className="dz-icon">🎞️</div>
                    <div className="dz-text">
                        <strong>Click to upload</strong>{" "}
                        <span className="muted">or drag & drop</span>
                    </div>
                    <div className="dz-hint">{hint}</div>
                </div>
            </label>

            {files.length > 0 && (
                <div className="file-chips">
                    {files.map((file, index) => (
                        <div key={index} className="chip" title={file.name}>
                            <span className="chip-index">{index + 1}</span>
                            <span className="chip-text">{file.name}</span>
                            <button
                                className="chip-remove"
                                onClick={() => removeFile(category, index)}
                                disabled={isProcessing || isZipping}
                                aria-label={`Remove ${file.name}`}
                            >
                                ×
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );

    const totalPossibleCombos = hookFiles.length * bodyFiles.length * ctaFiles.length;

    return (
        <div className="app">
            <div className="container">
                <div className="header">
                    <div className="title">
                        <h1>Video Combination Generator</h1>
                        <p className="subtitle">
                            Upload up to 3 clips per slot — we’ll generate every possible
                            sequence.
                        </p>
                    </div>
                </div>

                {/* Uploads */}
                <div className="grid grid-uploads">
                    <div className="col-4">
                        <UploadCard
                            files={hookFiles}
                            category="hook"
                            label="Hook"
                            hint="Up to 3 .mp4 files"
                        />
                    </div>
                    <div className="col-4">
                        <UploadCard
                            files={bodyFiles}
                            category="body"
                            label="Body"
                            hint="Up to 3 .mp4 files"
                        />
                    </div>
                    <div className="col-4">
                        <UploadCard
                            files={ctaFiles}
                            category="cta"
                            label="CTA"
                            hint="Up to 3 .mp4 files"
                        />
                    </div>
                </div>

                {/* Stats */}
                <div className="grid stats">
                    <div className="stat-card card">
                        <div className="stat-label">Selected</div>
                        <div className="stat-value">
                            {hookFiles.length} hooks · {bodyFiles.length} bodies ·{" "}
                            {ctaFiles.length} CTAs
                        </div>
                    </div>
                    <div className="stat-card card">
                        <div className="stat-label">Combinations</div>
                        <div className="stat-value">{totalPossibleCombos || 0}</div>
                    </div>
                    <div className="stat-card card">
                        <div className="stat-label">Generated</div>
                        <div className="stat-value">
                            {downloadUrls.length}/{totalCombos || 0}
                        </div>
                    </div>
                </div>

                {/* Actions */}
                <div className="toolbar" role="group" aria-label="Actions">
                    <button
                        className="btn primary"
                        onClick={handleGenerate}
                        disabled={!canGenerate}
                    >
                        {isProcessing
                            ? `Processing… ${Math.round(progressPct)}%`
                            : `Generate ${totalPossibleCombos || 0}`}
                    </button>
                    <button
                        className="btn ghost"
                        onClick={resetAll}
                        disabled={isProcessing || isZipping}
                    >
                        Reset
                    </button>
                    {downloadUrls.length > 0 && (
                        <button
                            className="btn info"
                            onClick={downloadAll}
                            disabled={isProcessing || isZipping}
                        >
                            {isZipping
                                ? "Zipping…"
                                : `Download All (${downloadUrls.length})`}
                        </button>
                    )}
                </div>

                {/* Progress */}
                {(isProcessing || isZipping || progressPct > 0) && (
                    <div className="progress" aria-live="polite">
                        <div
                            className="bar"
                            role="progressbar"
                            aria-valuenow={progressPct}
                            aria-valuemin="0"
                            aria-valuemax="100"
                        >
                            <div className="fill" style={{ width: `${progressPct}%` }} />
                        </div>
                        {currentCombo && (
                            <div className="progress-text">{currentCombo}</div>
                        )}
                    </div>
                )}

                {/* Downloads */}
                {downloadUrls.length > 0 && (
                    <div className="downloads card">
                        <strong>Generated Videos ({downloadUrls.length})</strong>
                        <div className="download-grid">
                            {downloadUrls.map((item, index) => (
                                <div key={index} className="download-item">
                                    <a
                                        className="download-link"
                                        href={item.url}
                                        download={item.name}
                                        title={item.name}
                                    >
                                        ⬇️ {item.name}
                                    </a>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Logs */}
                {logs.length > 0 && (
                    <pre className="logs" aria-live="polite">
            {logs.join("\n")}
          </pre>
                )}

                <p className="tip">
                    💡 Tip: Keep clips short for faster processing. Everything runs locally
                    in your browser.
                </p>
            </div>
        </div>
    );
}
