// 出品画面（フリマアプリ風の部分）と、デモ操作パネル（メタUI）の両方を扱う。
//
// - フリマ風の画面（.app-frame の中）: 普通の出品フォーム。JEV の存在・確率・条件 ID は出さない
// - デモ操作パネル（.demo-console）: 例を入れるボタンと、直前の出品を裏側から見た結果。
//   アプリの一部ではないことが分かるように、見た目も文言も分けてある。
const form = document.querySelector("#form");
const banner = document.querySelector("#banner");
const done = document.querySelector("#done");
const submit = document.querySelector("#submit");

const FIELDS = [
  "title",
  "body",
  "category",
  "condition",
  "shippingFee",
  "shippingDays",
  "price",
];

let drafts = [];
let meta = {
  feeRate: 0.1,
  rules: [],
  options: { categories: [], conditions: [], shippingFees: [], shippingDays: [] },
};

const STATUS_LABEL = {
  published: "公開中",
  review: "審査中",
  rejected: "出品不可",
  invalid: "形式エラー",
  checked: "確認中",
};

const yen = (value) => `¥${value.toLocaleString("ja-JP")}`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fillSelect(id, values, selected) {
  const select = document.querySelector(`#${id}`);
  const placeholder = el("option", undefined, "選択してください");
  placeholder.value = "";
  select.replaceChildren(
    placeholder,
    ...values.map((value) => {
      const option = el("option", undefined, value);
      option.value = value;
      option.selected = value === selected;
      return option;
    }),
  );
}

/** 写真の枠を差し替える（写真のない下書きはプレースホルダに戻す）。 */
function setPhoto(hasPhoto) {
  const slot = document.querySelector("#photo-1");
  slot.classList.toggle("filled", hasPhoto);
  slot.replaceChildren();
  if (hasPhoto) {
    const image = document.createElement("img");
    image.src = "/sample-camera.jpg";
    image.alt = "出品画像";
    slot.append(image);
  } else {
    slot.textContent = "＋";
  }
  document.querySelector("#preview-image").hidden = !hasPhoto;
}

function clearErrors() {
  banner.hidden = true;
  banner.textContent = "";
  for (const field of FIELDS) {
    const node = document.querySelector(`#err-${field}`);
    if (node) node.textContent = "";
  }
}

function showErrors(fieldErrors, formErrors) {
  const unplaced = [];
  for (const [field, messages] of Object.entries(fieldErrors ?? {})) {
    const node = document.querySelector(`#err-${field}`);
    if (node) node.textContent = messages.join(" ");
    else unplaced.push(...messages);
  }
  unplaced.push(...(formErrors ?? []));

  banner.replaceChildren();
  banner.append(el("strong", undefined, "出品できませんでした。入力内容をご確認ください。"));
  if (unplaced.length > 0) {
    const list = el("ul");
    for (const message of unplaced) list.append(el("li", undefined, message));
    banner.append(list);
  }
  banner.hidden = false;
}

/** 価格・プレビュー・文字数の表示を更新する。 */
function sync() {
  const price = Number(form.price.value || 0);
  const fee = Math.floor(price * meta.feeRate);
  document.querySelector("#fee").textContent = `-${yen(fee)}`;
  document.querySelector("#payout").textContent = yen(Math.max(price - fee, 0));
  document.querySelector("#body-count").textContent = String(form.body.value.length);

  const name = form.title.value.trim();
  document.querySelector("#preview-name").textContent = name === "" ? "商品名を入力してください" : name;
  document.querySelector("#preview-price").textContent = yen(price);
  document.querySelector("#preview-condition").textContent = form.condition.value || "商品の状態";
  document.querySelector("#preview-shipping").textContent = form.shippingFee.value || "配送料の負担";
  document.querySelector("#preview-days").textContent = form.shippingDays.value || "発送までの日数";
}

function showBadge(status) {
  const badge = document.querySelector("#preview-badge");
  badge.hidden = false;
  badge.className = `badge ${status}`;
  badge.textContent = status === "published" ? "公開中" : "審査中";
}

function showForm() {
  done.hidden = true;
  form.hidden = false;
  document.querySelector("#preview-badge").hidden = true;
}

/** 下書きをフォームに復元する。 */
function applyDraft(index) {
  const draft = drafts[index] ?? drafts[0];
  if (draft === undefined) return;
  const listing = draft.listing;

  form.title.value = listing.title;
  form.body.value = listing.body;
  form.category.value = listing.category;
  form.condition.value = listing.condition;
  form.shippingFee.value = listing.shippingFee;
  form.shippingDays.value = listing.shippingDays;
  form.price.value = String(listing.price);

  document.querySelector("#draft-note").textContent =
    index === 0 ? "前回の下書きを復元しました" : "下書きを復元しました";
  setPhoto(draft.photo !== false);
  clearErrors();
  sync();
}

function clearDraft() {
  for (const field of FIELDS) {
    if (form[field]) form[field].value = "";
  }
  document.querySelector("#draft-note").textContent = "下書きはありません";
  setPhoto(false);
  clearErrors();
  sync();
}

/* ---------------------------------------------------------------------------
   デモ操作パネル（メタUI）。フリマ風の画面の外側に置く。
   --------------------------------------------------------------------------- */

/** 「例を入れる」ボタン。 */
function renderSamples() {
  const box = document.querySelector("#demo-samples");
  box.replaceChildren(
    ...drafts.map((draft, index) => {
      const button = el("button", "demo-sample");
      button.type = "button";
      button.addEventListener("click", () => {
        showForm();
        applyDraft(index);
      });
      button.append(el("span", "demo-sample-name", draft.label));
      button.append(el("span", "demo-sample-item", draft.listing.title));
      return button;
    }),
  );
}

/** 直前の判定（出品時 or フォーカスを外した時）を裏側から見た結果。 */
function renderJudgment(demo) {
  const box = document.querySelector("#demo-result");
  if (demo === null || demo === undefined) {
    box.replaceChildren(
      el("p", "demo-muted", "まだ判定していません。入力してフォーカスを外すか、出品してください。"),
    );
    return;
  }

  const head = el("div", "demo-result-head");
  head.append(
    el("span", `demo-status ${demo.status}`, STATUS_LABEL[demo.status] ?? demo.status),
  );
  head.append(
    el(
      "span",
      "demo-muted",
      demo.origin === "precheck"
        ? "フォーカスを外した時点（まだ出品していません）"
        : (demo.id ?? ""),
    ),
  );
  box.replaceChildren(head);

  const table = el("table", "demo-table");
  const tbody = el("tbody");
  for (const rule of demo.rules) {
    const row = el("tr", rule.outcome === "skipped" ? "demo-skipped" : undefined);
    const mark = el(
      "td",
      "demo-mark",
      rule.outcome === "rejected"
        ? "✗"
        : rule.outcome === "uncertain"
          ? "▲"
          : rule.outcome === "unavailable"
            ? "!"
            : rule.outcome === "skipped"
              ? "·"
              : "✓",
    );
    mark.classList.add(
      rule.outcome === "rejected" || rule.outcome === "unavailable"
        ? "bad"
        : rule.outcome === "uncertain"
          ? "warn"
          : rule.outcome === "skipped"
            ? "off"
            : "ok",
    );
    row.append(mark);
    row.append(el("td", "demo-rule", rule.ruleId));

    const value = el("td", "demo-prob");
    value.textContent = rule.probability === null ? "—" : rule.probability.toFixed(2);
    row.append(value);

    const cell = el("td", "demo-bar-cell");
    if (rule.probability !== null) {
      const track = el("div", "demo-bar");
      const fill = el(
        "div",
        `demo-bar-fill ${rule.outcome === "rejected" ? "bad" : rule.outcome === "uncertain" ? "warn" : "ok"}`,
      );
      fill.style.width = `${Math.round(rule.probability * 100)}%`;
      track.append(fill);
      const threshold = el("div", "demo-bar-threshold");
      threshold.style.left = `${(rule.threshold * 100).toFixed(1)}%`;
      threshold.title = `合格の閾値: ${rule.threshold.toFixed(2)}`;
      track.append(threshold);
      cell.append(track);
    }
    row.append(cell);
    tbody.append(row);
  }
  table.append(tbody);
  box.append(table);

  box.append(
    el(
      "p",
      "demo-muted demo-metrics",
      [
        `model=${demo.jev.model ?? "-"}`,
        `questions=${demo.jev.questionCount}`,
        `tokens=${demo.jev.inputTokens}`,
        `${demo.jev.latencyMs}ms`,
      ].join(" / "),
    ),
  );

  const verdict =
    demo.origin === "precheck"
      ? demo.rules.some((rule) => rule.outcome === "rejected")
        ? "→ このままでは出品できません（該当項目に理由が出ています）"
        : "→ ここまでは問題なし。出品するまで結果は確定しません"
      : demo.status === "rejected"
        ? "→ 出品不可（理由は該当項目の下に出る）"
        : demo.status === "review"
          ? "→ 審査中（利用者には「審査が終わり次第公開」とだけ出る）"
          : "→ 公開中（全条件が成立）";
  box.append(el("p", "demo-verdict", verdict));
}

/* ---------------------------------------------------------------------------
   送信
   --------------------------------------------------------------------------- */

/** 途中チェック（フォーカスを外したとき）の制御。 */
let checkTimer;
let checking = false;
let lastChecked = "";

function formPayload() {
  return {
    title: form.title.value,
    body: form.body.value,
    category: form.category.value,
    condition: form.condition.value,
    shippingFee: form.shippingFee.value,
    shippingDays: form.shippingDays.value,
    price: form.price.value,
  };
}

const isEmptyPayload = (payload) =>
  payload.title === "" &&
  payload.body === "" &&
  payload.category === "" &&
  payload.condition === "" &&
  payload.price === "";

/** 該当フィールドのインラインに出す（全体のバナーは出さない＝まだ出品していないため）。 */
function showInline(messages) {
  for (const { field, message } of messages) {
    const node = document.querySelector(`#err-${field}`);
    if (node) node.textContent = message;
  }
}

function scheduleCheck() {
  if (form.hidden) return; // 完了画面を出しているときは何もしない
  clearTimeout(checkTimer);
  checkTimer = setTimeout(runCheck, 400); // 連続でフォーカスが移るのをまとめる
}

async function runCheck() {
  if (checking) return;
  const payload = formPayload();
  if (isEmptyPayload(payload)) return;
  const key = JSON.stringify(payload);
  if (key === lastChecked) return; // 同じ内容なら再判定しない

  checking = true;
  try {
    const response = await fetch("/api/listings/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: key,
    });
    const data = await response.json();
    lastChecked = key;
    clearErrors();

    if (data.ok === false) {
      // 形のエラー（文字数など）はその場で出す
      for (const [field, messages] of Object.entries(data.fieldErrors ?? {})) {
        showInline([{ field, message: messages.join(" ") }]);
      }
      return;
    }

    renderJudgment(data.judgment);
    if (meta.mode === "enforce") {
      // 意味の違反も、フォーカスを外した時点で該当項目の下に出す
      showInline(
        data.judgment.rules
          .filter((rule) => rule.outcome === "rejected" && rule.field !== null)
          .map((rule) => ({ field: rule.field, message: rule.message })),
      );
    }
  } catch {
    // 途中チェックの失敗は黙って無視する（出品時にあらためて判定される）
  } finally {
    checking = false;
  }
}

async function submitListing(event) {
  event.preventDefault();
  clearErrors();
  submit.disabled = true;
  submit.textContent = "出品中…";

  try {
    const response = await fetch("/api/listings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(formPayload()),
    });
    const data = await response.json();

    // デモ操作パネルに裏側の判定を出す（本番の API はこの情報を返さない）
    lastChecked = JSON.stringify(formPayload());
    renderJudgment(data.demo ?? null);

    if (response.status === 422) {
      showErrors(data.fieldErrors, data.formErrors);
      return;
    }
    if (!response.ok) throw new Error(data.error ?? "出品できませんでした");

    form.hidden = true;
    banner.hidden = true;
    done.hidden = false;
    document.querySelector("#done-id").textContent = data.id;
    if (data.status === "review") {
      document.querySelector("#done-title").textContent = "出品を受け付けました";
      document.querySelector("#done-note").textContent =
        "内容を確認しています。審査が終わり次第、商品が公開されます。";
    } else {
      document.querySelector("#done-title").textContent = "出品が完了しました";
      document.querySelector("#done-note").textContent =
        "商品が公開されました。購入者からのメッセージをお待ちください。";
    }
    showBadge(data.status);
  } catch (error) {
    banner.replaceChildren();
    banner.append(
      el("strong", undefined, `出品できませんでした。（${String(error.message ?? error)}）`),
    );
    banner.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = "出品する";
  }
}

async function main() {
  meta = await (await fetch("/api/meta")).json();
  drafts = meta.samples ?? [];

  fillSelect("category", meta.options.categories, "");
  fillSelect("condition", meta.options.conditions, "");
  fillSelect("shippingFee", meta.options.shippingFees, "");
  fillSelect("shippingDays", meta.options.shippingDays, "");
  document.querySelector("#fee-rate").textContent = String(Math.round(meta.feeRate * 100));
  document.querySelector("#demo-mode").textContent = meta.fake
    ? "いまは --fake（偽の判定・課金なし）で動いています。"
    : "いまは実 API に問い合わせています。";
  renderSamples();

  form.addEventListener("submit", submitListing);
  form.addEventListener("input", sync);
  form.addEventListener("change", sync);
  // フォーカスを外したときに判定する（出品ボタンを押すのを待たない）
  form.addEventListener("focusout", scheduleCheck);
  form.addEventListener("change", scheduleCheck);
  document.querySelector("#draft-clear").addEventListener("click", (event) => {
    event.preventDefault();
    clearDraft();
  });
  document.querySelector("#demo-reset").addEventListener("click", () => {
    showForm();
    applyDraft(0);
    renderJudgment(null);
  });
  document.querySelector("#again").addEventListener("click", () => {
    showForm();
    applyDraft(0);
  });
  for (const slot of document.querySelectorAll(".photo.add")) {
    slot.addEventListener("click", () => {
      banner.replaceChildren();
      banner.append(el("strong", undefined, "デモのため画像の追加はできません。"));
      banner.hidden = false;
    });
  }

  applyDraft(0);
}

main();
