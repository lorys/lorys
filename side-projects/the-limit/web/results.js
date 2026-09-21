const FONT = { family: "biro", size: 20 };

const CHART_CDN = "https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js";

let chartLoader = null;
const loadChart = () => {
    if (!chartLoader) {
        chartLoader = new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = CHART_CDN;
            script.onload = () => resolve(window.Chart);
            script.onerror = () => reject(new Error("could not load chart.js"));
            document.head.appendChild(script);
        });
    }
    return chartLoader;
};

/** Answers are numbers more often than not, so keep them in numeric order. */
const sortAnswers = (keys) => {
    const numeric = keys.every(k => k !== "" && !isNaN(Number(k)));
    return [...keys].sort(numeric ? (a, b) => Number(a) - Number(b) : (a, b) => a.localeCompare(b));
};

const sumCountries = (byCountries, only) => {
    const totals = {};
    for (const [country, answers] of Object.entries(byCountries || {})) {
        if (only && country !== only) continue;
        for (const [answer, count] of Object.entries(answers)) {
            totals[answer] = (totals[answer] || 0) + count;
        }
    }
    return totals;
};

const countryLabel = (code) => {
    if (code === "XX") return "Unknown";
    try {
        return new Intl.DisplayNames(["en"], { type: "region" }).of(code) || code;
    } catch {
        return code;
    }
};

const showResults = async (payload, yourAnswer) => {
    if (document.querySelector(".modal-backdrop")) return;

    const countries = Object.keys(payload.byCountries || {}).sort();
    const you = yourAnswer === undefined || yourAnswer === null ? null : String(yourAnswer);

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
        <div class="modal">
            <h2 class="title">Everyone else</h2>
            <select class="modal-select">
                <option value="">Worldwide</option>
                ${countries.map(c => `<option value="${c}">${countryLabel(c)}</option>`).join("")}
            </select>
            <div class="modal-chart"><canvas></canvas></div>
            <span class="subtitle modal-total"></span>
            <button class="modal-next">Next question</button>
        </div>
    `;
    document.body.appendChild(backdrop);

    const next = window.__QUESTION__ ? window.__QUESTION__.index + 1 : 0;
    backdrop.querySelector(".modal-next").onclick = () => { self.location.href = `/play/${next}`; };

    const Chart = await loadChart();
    /* Canvas text needs the webfont resolved before Chart.js measures it. */
    if (document.fonts) await document.fonts.load('20px biro');

    const canvas = backdrop.querySelector("canvas");
    const total = backdrop.querySelector(".modal-total");
    let chart = null;

    const draw = (country) => {
        const totals = sumCountries(payload.byCountries, country);
        const labels = sortAnswers(Object.keys(totals));
        const data = labels.map(l => totals[l]);
        const count = data.reduce((a, b) => a + b, 0);

        total.textContent = `${count} answer${count === 1 ? "" : "s"}${country ? ` from ${countryLabel(country)}` : ""}`;

        if (chart) chart.destroy();
        chart = new Chart(canvas, {
            type: "bar",
            data: {
                labels,
                datasets: [{
                    data,
                    backgroundColor: labels.map(l => l === you ? "#000" : "#fff"),
                    borderColor: "#000",
                    borderWidth: 2,
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 400 },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        displayColors: false,
                        bodyFont: FONT,
                        titleFont: FONT,
                        callbacks: {
                            label: (ctx) => `${ctx.parsed.y} answer${ctx.parsed.y === 1 ? "" : "s"}${ctx.label === you ? " (yours)" : ""}`
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        border: { color: "#000", width: 2 },
                        ticks: { font: FONT, color: "#000" }
                    },
                    y: {
                        beginAtZero: true,
                        grid: { color: "rgba(0, 0, 0, 0.1)" },
                        border: { color: "#000", width: 2 },
                        ticks: { precision: 0, font: FONT, color: "#000" }
                    }
                }
            }
        });
    };

    backdrop.querySelector(".modal-select").onchange = (e) => draw(e.target.value);
    draw("");
};

const submitAnswer = async (answer) => {
    const question = window.__QUESTION__ ? window.__QUESTION__.name : null;
    if (!question) return;

    const req = await fetch("/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, answer })
    });

    if (!req.ok) return;

    showResults(await req.json(), answer);
};
