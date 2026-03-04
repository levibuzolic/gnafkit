export function homepageResponse(): Response {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>gnafkit</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f1e8;
        --panel: rgba(255, 252, 247, 0.82);
        --panel-strong: #fffdf8;
        --ink: #1c160f;
        --muted: #6f6251;
        --line: rgba(28, 22, 15, 0.12);
        --accent: #af3f24;
        --accent-2: #255f5a;
        --shadow: 0 24px 60px rgba(61, 34, 11, 0.12);
        --radius: 24px;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: Georgia, "Times New Roman", serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(175, 63, 36, 0.16), transparent 28%),
          radial-gradient(circle at top right, rgba(37, 95, 90, 0.18), transparent 24%),
          linear-gradient(180deg, #f9f4eb 0%, var(--bg) 100%);
      }

      body::before {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        opacity: 0.18;
        background-image:
          linear-gradient(rgba(28, 22, 15, 0.045) 1px, transparent 1px),
          linear-gradient(90deg, rgba(28, 22, 15, 0.045) 1px, transparent 1px);
        background-size: 32px 32px;
        mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.9), transparent);
      }

      main {
        width: min(1120px, calc(100% - 32px));
        margin: 0 auto;
        padding: 40px 0 56px;
      }

      .hero {
        position: relative;
        overflow: hidden;
        padding: 32px;
        border: 1px solid var(--line);
        border-radius: calc(var(--radius) + 6px);
        background: linear-gradient(135deg, rgba(255, 253, 248, 0.92), rgba(245, 236, 222, 0.78));
        box-shadow: var(--shadow);
      }

      .hero::after {
        content: "G-NAF";
        position: absolute;
        right: 20px;
        top: 12px;
        font-size: clamp(3rem, 8vw, 8rem);
        letter-spacing: 0.08em;
        color: rgba(28, 22, 15, 0.06);
        font-weight: 700;
      }

      .eyebrow {
        margin: 0 0 10px;
        font-size: 0.8rem;
        letter-spacing: 0.24em;
        text-transform: uppercase;
        color: var(--accent-2);
      }

      h1 {
        margin: 0;
        max-width: 10ch;
        font-size: clamp(3rem, 7vw, 5.4rem);
        line-height: 0.92;
        font-weight: 700;
      }

      .hero p {
        margin: 18px 0 0;
        max-width: 58ch;
        font-size: 1.05rem;
        line-height: 1.6;
        color: var(--muted);
      }

      .layout {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 18px;
        margin-top: 22px;
      }

      .docs {
        margin-top: 22px;
        padding: 24px;
        border: 1px solid var(--line);
        border-radius: calc(var(--radius) + 2px);
        background: rgba(255, 250, 243, 0.78);
        box-shadow: var(--shadow);
      }

      .docs-header {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: end;
        margin-bottom: 18px;
      }

      .docs-header h2 {
        margin: 0;
        font-size: 1.6rem;
      }

      .docs-header p {
        max-width: 52ch;
      }

      .docs-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 14px;
      }

      .panel {
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 22px;
        border: 1px solid var(--line);
        border-radius: var(--radius);
        background: var(--panel);
        backdrop-filter: blur(12px);
        box-shadow: var(--shadow);
      }

      .panel h2 {
        margin: 0;
        font-size: 1.4rem;
      }

      .endpoint {
        margin: -4px 0 0;
        color: var(--accent);
        font-size: 0.9rem;
      }

      .panel p {
        margin: 0;
        color: var(--muted);
        line-height: 1.5;
      }

      .doc-card {
        display: grid;
        gap: 10px;
        padding: 18px;
        border: 1px solid rgba(28, 22, 15, 0.1);
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.66);
      }

      .doc-card h3 {
        margin: 0;
        font-size: 1.08rem;
      }

      .doc-list {
        display: grid;
        gap: 6px;
      }

      .doc-list p {
        margin: 0;
        font-size: 0.92rem;
      }

      .doc-example {
        padding: 12px 14px;
        border-radius: 14px;
        background: rgba(28, 22, 15, 0.04);
        border: 1px dashed rgba(28, 22, 15, 0.1);
        color: var(--ink);
        font-size: 0.84rem;
      }

      form {
        display: grid;
        gap: 12px;
      }

      label {
        display: grid;
        gap: 6px;
        font-size: 0.9rem;
      }

      .field-label {
        font-size: 0.78rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }

      input {
        width: 100%;
        padding: 12px 14px;
        border: 1px solid rgba(28, 22, 15, 0.16);
        border-radius: 14px;
        font: inherit;
        color: var(--ink);
        background: rgba(255, 255, 255, 0.8);
      }

      input:focus {
        outline: 2px solid rgba(175, 63, 36, 0.18);
        border-color: rgba(175, 63, 36, 0.44);
      }

      button {
        width: fit-content;
        padding: 12px 18px;
        border: 0;
        border-radius: 999px;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
        transition: transform 120ms ease, box-shadow 120ms ease, opacity 120ms ease;
      }

      button:hover {
        transform: translateY(-1px);
      }

      button:disabled {
        opacity: 0.7;
        cursor: wait;
        transform: none;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .primary-button {
        color: #fffaf4;
        background: linear-gradient(135deg, var(--accent), #ca6f34);
        box-shadow: 0 10px 24px rgba(175, 63, 36, 0.24);
      }

      .primary-button:hover {
        box-shadow: 0 14px 28px rgba(175, 63, 36, 0.28);
      }

      .secondary-button {
        color: var(--ink);
        background: rgba(255, 255, 255, 0.72);
        border: 1px solid rgba(28, 22, 15, 0.12);
      }

      .copy-status {
        min-height: 1.2em;
        font-size: 0.82rem;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: var(--accent-2);
      }

      .result {
        min-height: 136px;
        padding: 16px;
        border: 1px dashed rgba(28, 22, 15, 0.14);
        border-radius: 18px;
        background: var(--panel-strong);
      }

      .status {
        margin: 0 0 12px;
        font-size: 0.82rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--accent-2);
      }

      .error {
        color: #8e2f1d;
      }

      .result-list {
        display: grid;
        gap: 10px;
      }

      .result-item {
        padding: 12px 0 0;
        border-top: 1px solid rgba(28, 22, 15, 0.08);
      }

      .result-item:first-child {
        padding-top: 0;
        border-top: 0;
      }

      .title {
        margin: 0 0 4px;
        font-size: 1rem;
      }

      .meta {
        margin: 0;
        color: var(--muted);
        line-height: 1.45;
        font-size: 0.92rem;
      }

      pre {
        margin: 12px 0 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 0.86rem;
        line-height: 1.45;
      }

      @media (max-width: 720px) {
        main {
          width: min(100% - 20px, 1120px);
          padding-top: 18px;
        }

        .hero,
        .panel {
          padding: 18px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <p class="eyebrow">gnafkit interface</p>
        <h1>Query every endpoint from one page.</h1>
        <p>Use the forms below to hit the local API directly. Each request is sent with query parameters and the response is rendered inline, including a readable summary plus the raw JSON payload.</p>
      </section>

      <section class="layout">
        <article class="panel">
          <h2>Health</h2>
          <div class="endpoint">GET /health</div>
          <p>Checks server status and reports the currently opened database metadata.</p>
          <form data-endpoint="/health">
            <div class="actions">
              <button class="primary-button" type="submit">Run health check</button>
              <button class="secondary-button" type="button" data-copy-curl>Copy curl</button>
            </div>
            <div class="copy-status" data-copy-status></div>
          </form>
          <div class="result" data-result>
            <p class="status">Ready</p>
            <p class="meta">No request sent yet.</p>
          </div>
        </article>

        <article class="panel">
          <h2>Autocomplete</h2>
          <div class="endpoint">GET /autocomplete</div>
          <p>Prefix search for likely addresses while the user is typing.</p>
          <form data-endpoint="/autocomplete">
            <label>
              <span class="field-label">Query</span>
              <input name="q" value="120 collins melb" required />
            </label>
            <label>
              <span class="field-label">Limit</span>
              <input name="limit" type="number" min="1" max="20" value="5" />
            </label>
            <div class="actions">
              <button class="primary-button" type="submit">Search suggestions</button>
              <button class="secondary-button" type="button" data-copy-curl>Copy curl</button>
            </div>
            <div class="copy-status" data-copy-status></div>
          </form>
          <div class="result" data-result>
            <p class="status">Ready</p>
            <p class="meta">No request sent yet.</p>
          </div>
        </article>

        <article class="panel">
          <h2>Geocode</h2>
          <div class="endpoint">GET /geocode</div>
          <p>Resolve a user-supplied address into stored address records.</p>
          <form data-endpoint="/geocode">
            <label>
              <span class="field-label">Address</span>
              <input name="q" value="120 Collins Street Melbourne VIC 3000" required />
            </label>
            <div class="actions">
              <button class="primary-button" type="submit">Geocode address</button>
              <button class="secondary-button" type="button" data-copy-curl>Copy curl</button>
            </div>
            <div class="copy-status" data-copy-status></div>
          </form>
          <div class="result" data-result>
            <p class="status">Ready</p>
            <p class="meta">No request sent yet.</p>
          </div>
        </article>
      </section>

      <section class="docs">
        <div class="docs-header">
          <div>
            <p class="eyebrow">Endpoint Notes</p>
            <h2>Parameters and examples</h2>
          </div>
          <p>These are the same routes exposed by the API. Required fields are called out explicitly, and optional limits are clamped by the server to a maximum of 20.</p>
        </div>

        <div class="docs-grid">
          <article class="doc-card">
            <h3><code>GET /health</code></h3>
            <div class="doc-list">
              <p>No parameters.</p>
              <p>Returns API status plus opened SQLite database metadata.</p>
            </div>
            <div class="doc-example"><code>/health</code></div>
          </article>

          <article class="doc-card">
            <h3><code>GET /autocomplete</code></h3>
            <div class="doc-list">
              <p><strong><code>q</code></strong>: free-text prefix query.</p>
              <p><strong><code>limit</code></strong>: optional, defaults to <code>10</code>.</p>
              <p>Best for partial address entry such as street number plus suburb.</p>
            </div>
            <div class="doc-example"><code>/autocomplete?q=120%20collins%20melb&amp;limit=5</code></div>
          </article>

          <article class="doc-card">
            <h3><code>GET /geocode</code></h3>
            <div class="doc-list">
              <p><strong><code>q</code></strong>: required full or near-full address.</p>
              <p>Returns ranked matches, preferring exact normalized addresses first.</p>
            </div>
            <div class="doc-example"><code>/geocode?q=120%20Collins%20Street%20Melbourne%20VIC%203000</code></div>
          </article>

        </div>
      </section>
    </main>

    <script>
      function escapeHtml(value) {
        return String(value).replace(/[&<>"]/g, function (char) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char];
        });
      }

      function shellEscape(value) {
        return "'" + String(value).replace(/'/g, "'\\\\''") + "'";
      }

      function formatNumber(value) {
        return typeof value === "number" ? value.toLocaleString(undefined, { maximumFractionDigits: 3 }) : "n/a";
      }

      function getParams(form) {
        const params = new URLSearchParams();

        for (const [key, value] of new FormData(form).entries()) {
          if (String(value).trim() !== "") {
            params.set(key, String(value));
          }
        }

        return params;
      }

      function buildUrl(form) {
        const endpoint = form.dataset.endpoint;
        const params = getParams(form);
        return params.size > 0 ? endpoint + "?" + params.toString() : endpoint;
      }

      function buildCurlCommand(form) {
        const absoluteUrl = new URL(buildUrl(form), window.location.origin).toString();
        return "curl " + shellEscape(absoluteUrl);
      }

      function renderRecord(record) {
        const location = [record.localityName, record.stateAbbreviation, record.postcode].filter(Boolean).join(", ");
        const coords = record.latitude != null && record.longitude != null
          ? record.latitude.toFixed(6) + ", " + record.longitude.toFixed(6)
          : "No coordinates";
        return '<div class="result-item">' +
          '<p class="title">' + escapeHtml(record.fullAddress || "Unnamed result") + '</p>' +
          '<p class="meta">' + escapeHtml(location || "Location unavailable") + '</p>' +
          '<p class="meta">Coordinates: ' + escapeHtml(coords) + '</p>' +
          '</div>';
      }

      function renderSummary(payload) {
        if (payload && payload.database) {
          return '<p class="meta">Database metadata loaded successfully.</p><pre>' + escapeHtml(JSON.stringify(payload.database, null, 2)) + '</pre>';
        }

        if (payload && Array.isArray(payload.results)) {
          if (payload.results.length === 0) {
            return '<p class="meta">No results returned.</p><pre>' + escapeHtml(JSON.stringify(payload, null, 2)) + '</pre>';
          }

          return '<div class="result-list">' + payload.results.map(renderRecord).join("") + '</div>' +
            '<pre>' + escapeHtml(JSON.stringify(payload, null, 2)) + '</pre>';
        }

        return '<pre>' + escapeHtml(JSON.stringify(payload, null, 2)) + '</pre>';
      }

      async function copyCurl(form) {
        const status = form.querySelector("[data-copy-status]");

        try {
          await navigator.clipboard.writeText(buildCurlCommand(form));
          status.textContent = "Curl copied";
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : String(error);
          status.classList.add("error");
          return;
        }

        status.classList.remove("error");
        window.setTimeout(function () {
          if (status.textContent === "Curl copied") {
            status.textContent = "";
          }
        }, 1800);
      }

      async function handleSubmit(event) {
        event.preventDefault();

        const form = event.currentTarget;
        const button = form.querySelector('button[type="submit"]');
        const result = form.parentElement.querySelector("[data-result]");
        const url = buildUrl(form);

        button.disabled = true;
        result.innerHTML = '<p class="status">Loading</p><p class="meta">' + escapeHtml(url) + '</p>';

        try {
          const response = await fetch(url, {
            headers: {
              "accept": "application/json"
            }
          });

          const payload = await response.json();
          const statusClass = response.ok ? "status" : "status error";
          result.innerHTML = '<p class="' + statusClass + '">HTTP ' + response.status + '</p>' + renderSummary(payload);
        } catch (error) {
          result.innerHTML = '<p class="status error">Request failed</p><p class="meta">' + escapeHtml(error instanceof Error ? error.message : String(error)) + '</p>';
        } finally {
          button.disabled = false;
        }
      }

      for (const form of document.querySelectorAll("form[data-endpoint]")) {
        form.addEventListener("submit", handleSubmit);

        const copyButton = form.querySelector("[data-copy-curl]");
        copyButton.addEventListener("click", function () {
          void copyCurl(form);
        });
      }
    </script>
  </body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
  });
}
