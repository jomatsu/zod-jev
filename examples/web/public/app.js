// 出品画面（利用者向け）。
// JEV の存在・確率・条件 ID は出さない。表示は「出品が完了しました / 審査中です /
// 出品できません（理由は該当項目の下）」という普通の結果だけ。
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

/**
 * 下書き（実際のアプリでも下書きは保存される）。
 * デモ用の一覧はサーバーの /api/meta から受け取り、1 件目を初期表示に使う。
 */
let drafts = [];
let currentDraft = 0;

let meta = { feeRate: 0.1, options: { categories: [], conditions: [], shippingFees: [], shippingDays: [] } };

const yen = (value) => `¥${value.toLocaleString("ja-JP")}`;

function fillSelect(id, values, selected) {
  const select = document.querySelector(`#${id}`);
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "選択してください";
  select.replaceChildren(
    placeholder,
    ...values.map((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      option.selected = value === selected;
      return option;
    }),
  );
}

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

/** 下書きをフォームに復元する。 */
function applyDraft(index) {
  const draft = drafts[index] ?? drafts[0];
  if (draft === undefined) return;
  currentDraft = index;
  const listing = draft.listing;

  form.title.value = listing.title;
  form.body.value = listing.body;
  form.category.value = listing.category;
  form.condition.value = listing.condition;
  form.shippingFee.value = listing.shippingFee;
  form.shippingDays.value = listing.shippingDays;
  form.price.value = String(listing.price);

  document.querySelector("#draft-note").textContent = "下書きを復元しました";
  setPhoto(draft.photo !== false);
  document.querySelector("#drafts").hidden = true;
  clearErrors();
  sync();
  markCurrentDraft();
}

function clearDraft() {
  for (const field of FIELDS) {
    if (form[field]) form[field].value = "";
  }
  document.querySelector("#draft-note").textContent = "下書きはありません";
  setPhoto(false);
  document.querySelector("#drafts").hidden = true;
  clearErrors();
  sync();
  markCurrentDraft();
}

function markCurrentDraft() {
  for (const node of document.querySelectorAll(".draft-item")) {
    node.classList.toggle("is-current", Number(node.dataset.index) === currentDraft);
  }
}

function renderDrafts() {
  const list = document.querySelector("#draft-list");
  list.replaceChildren(
    ...drafts.map((draft, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "draft-item";
      button.dataset.index = String(index);
      button.addEventListener("click", () => applyDraft(index));

      const thumb = document.createElement(draft.photo === false ? "div" : "img");
      thumb.className = "thumb";
      if (draft.photo === false) thumb.textContent = "＋";
      else {
        thumb.src = "/sample-camera.jpg";
        thumb.alt = "";
      }
      button.append(thumb);

      const info = document.createElement("div");
      info.className = "info";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = draft.listing.title;
      const metaLine = document.createElement("div");
      metaLine.className = "meta";
      metaLine.textContent = `${draft.label} / ${draft.updated ?? ""}`;
      info.append(name, metaLine);
      button.append(info);

      const pick = document.createElement("span");
      pick.className = "pick";
      pick.textContent = "この内容で入力";
      button.append(pick);
      return button;
    }),
  );
  markCurrentDraft();
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
  const title = document.createElement("strong");
  title.textContent = "出品できませんでした。入力内容をご確認ください。";
  banner.append(title);
  if (unplaced.length > 0) {
    const list = document.createElement("ul");
    for (const message of unplaced) {
      const item = document.createElement("li");
      item.textContent = message;
      list.append(item);
    }
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

function showDone(result) {
  form.hidden = true;
  banner.hidden = true;
  done.hidden = false;
  document.querySelector("#done-id").textContent = result.id;
  if (result.status === "review") {
    document.querySelector("#done-title").textContent = "出品を受け付けました";
    document.querySelector("#done-note").textContent =
      "内容を確認しています。審査が終わり次第、商品が公開されます。";
  } else {
    document.querySelector("#done-title").textContent = "出品が完了しました";
    document.querySelector("#done-note").textContent =
      "商品が公開されました。購入者からのメッセージをお待ちください。";
  }
  showBadge(result.status);
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
      body: JSON.stringify({
        title: form.title.value,
        body: form.body.value,
        category: form.category.value,
        condition: form.condition.value,
        shippingFee: form.shippingFee.value,
        shippingDays: form.shippingDays.value,
        price: form.price.value,
      }),
    });
    const data = await response.json();

    if (response.status === 422) {
      showErrors(data.fieldErrors, data.formErrors);
      return;
    }
    if (!response.ok) throw new Error(data.error ?? "出品できませんでした");
    showDone(data);
  } catch (error) {
    banner.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = `出品できませんでした。（${String(error.message ?? error)}）`;
    banner.append(title);
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
  renderDrafts();

  form.addEventListener("submit", submitListing);
  form.addEventListener("input", sync);
  form.addEventListener("change", sync);
  document.querySelector("#draft-toggle").addEventListener("click", (event) => {
    event.preventDefault();
    const panel = document.querySelector("#drafts");
    panel.hidden = !panel.hidden;
    if (!panel.hidden) panel.scrollIntoView({ block: "nearest" });
  });
  document.querySelector("#draft-clear").addEventListener("click", (event) => {
    event.preventDefault();
    clearDraft();
  });
  document.querySelector("#again").addEventListener("click", () => {
    done.hidden = true;
    form.hidden = false;
    document.querySelector("#preview-badge").hidden = true;
    applyDraft(0); // 続けて出品するときは 1 件目の下書きから始める
  });
  for (const slot of document.querySelectorAll(".photo.add")) {
    slot.addEventListener("click", () => {
      banner.replaceChildren();
      const note = document.createElement("strong");
      note.textContent = "デモのため画像の追加はできません。";
      banner.append(note);
      banner.hidden = false;
    });
  }

  applyDraft(0);
}

main();
