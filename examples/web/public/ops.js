// 開発者向け: 出品フォームの裏側で JEV が何を判定したかを見るページ。
const STATUS_LABEL = {
  published: "公開中",
  review: "審査中",
  rejected: "出品不可",
  invalid: "形式エラー",
};

const open = new Set();
let rendered = false;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const yen = (value) => `¥${Number(value).toLocaleString("ja-JP")}`;

async function refresh() {
  const [metaResponse, listResponse] = await Promise.all([
    fetch("/api/meta"),
    fetch("/api/listings"),
  ]);
  const meta = await metaResponse.json();
  const { records } = await listResponse.json();

  document.querySelector("#mode-pill").textContent = `mode=${meta.mode}`;
  document.querySelector("#api-pill").textContent = meta.fake
    ? "--fake（偽の判定・課金なし）"
    : `実 API: ${meta.endpoint}`;
  document.querySelector("#count").textContent = `${records.length} 件`;

  if (!rendered) {
    renderRules(meta.rules);
    renderSamples(meta.samples);
    rendered = true;
  }
  renderList(records);
}

function renderRules(rules) {
  const table = el("table");
  const head = el("thead");
  const headRow = el("tr");
  for (const label of ["条件 ID", "成立していてほしい条件（はい で確率が 1 に近づく）", "閾値", "違反時の文言"]) {
    headRow.append(el("th", undefined, label));
  }
  head.append(headRow);
  table.append(head);

  const tbody = el("tbody");
  for (const rule of rules) {
    const row = el("tr");
    row.append(el("td", "rule-id", rule.id));
    row.append(el("td", undefined, rule.is));
    row.append(el("td", undefined, rule.threshold.toFixed(2)));
    row.append(el("td", "muted", rule.message));
    tbody.append(row);
  }
  table.append(tbody);
  document.querySelector("#rules").replaceChildren(table);
}

function renderSamples(samples) {
  const box = document.querySelector("#samples");
  box.replaceChildren(
    ...samples.map((sample) => {
      const button = el("button", undefined, sample.label);
      button.type = "button";
      button.addEventListener("click", async () => {
        button.disabled = true;
        await fetch("/api/listings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sample.listing),
        });
        button.disabled = false;
        await refresh();
      });
      return button;
    }),
  );
}

function renderList(records) {
  const list = document.querySelector("#list");
  if (records.length === 0) {
    list.replaceChildren(el("p", "muted", "まだ出品がありません。"));
    return;
  }
  list.replaceChildren(...records.map(renderRecord));
}

function probabilityBar(probability, threshold) {
  const bar = el("div", "bar");
  const fill = el("div", "fill");
  fill.style.width = `${Math.round(probability * 100)}%`;
  bar.append(fill);
  for (const [value, title] of [
    [1 - threshold, "却下の下限（1-閾値）"],
    [threshold, "合格の閾値"],
  ]) {
    const marker = el("div", "marker");
    marker.style.left = `${(value * 100).toFixed(1)}%`;
    marker.title = `${title}: ${value.toFixed(2)}`;
    bar.append(marker);
  }
  return bar;
}

function renderIssue(issue) {
  const { details } = issue;
  const box = el("div", "issue");
  const head = el("div", "issue-head");
  head.append(el("span", `kind ${details.kind}`, details.kind));

  if (details.kind === "unavailable") {
    const suffix = details.status === undefined ? "" : ` (HTTP ${details.status})`;
    head.append(el("span", "rule-id", `${details.reason}${suffix}`));
  } else {
    head.append(el("span", "rule-id", details.ruleId));
  }
  if (issue.path.length > 0) head.append(el("span", "muted", issue.path.join(".")));
  if (details.kind !== "unavailable") {
    head.append(
      el("span", "prob", `P=${details.probability.toFixed(2)} / 閾値=${details.threshold.toFixed(2)}`),
    );
  }
  box.append(head);
  if (details.kind !== "unavailable") {
    box.append(probabilityBar(details.probability, details.threshold));
  }
  box.append(el("p", undefined, issue.message));
  return box;
}

function renderRecord(record) {
  const details = el("details", "record");
  details.open = open.has(record.id);
  details.addEventListener("toggle", () => {
    if (details.open) open.add(record.id);
    else open.delete(record.id);
  });

  const summary = el("summary");
  summary.append(el("span", `pill ${record.status}`, STATUS_LABEL[record.status]));
  summary.append(el("span", "muted", record.at.slice(11, 19)));
  summary.append(el("span", undefined, yen(record.listing.price)));
  summary.append(el("span", undefined, record.listing.title));
  summary.append(el("span", "excerpt", record.listing.body));
  summary.append(el("span", "muted", record.id));
  details.append(summary);

  const body = el("div", "detail");
  body.append(
    el(
      "p",
      "muted",
      `${record.listing.category} / ${record.listing.condition} / ${record.listing.shippingFee} / ${record.listing.shippingDays}`,
    ),
  );
  body.append(el("p", undefined, record.listing.body));

  if (record.mode === "shadow") {
    body.append(
      el("p", "muted", "shadow モードの記録です。この出品は「公開中」のままで、判定は挙動に使っていません。"),
    );
  }

  if (record.issues.length === 0) {
    body.append(el("p", "muted", "意味の条件はすべて成立しています（issue なし）。"));
  } else {
    const issues = el("div");
    for (const issue of record.issues) issues.append(renderIssue(issue));
    body.append(issues);
  }

  const metrics = el("div", "metrics");
  const items = [
    `mode=${record.mode}`,
    record.jev.model === null ? null : `model=${record.jev.model}`,
    record.jev.questionCount > 0 ? `questions=${record.jev.questionCount}` : null,
    `input_tokens=${record.jev.inputTokens}`,
    `output_tokens=${record.jev.outputTokens}`,
    `latency=${record.jev.latencyMs}ms`,
  ].filter((item) => item !== null);
  for (const item of items) metrics.append(el("span", undefined, item));
  body.append(metrics);

  const raw = el("details", "raw");
  raw.append(el("summary", undefined, "JEV に送った内容 / 返ってきた確率"));
  raw.append(
    el(
      "pre",
      "json",
      JSON.stringify(
        {
          state: record.jev.state,
          questions: record.jev.questions,
          answers: record.jev.answers,
        },
        null,
        2,
      ),
    ),
  );
  body.append(raw);

  details.append(body);
  return details;
}

await refresh();
setInterval(() => {
  refresh().catch(() => {});
}, 3000);
