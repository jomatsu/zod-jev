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

/** 前回の下書き（実際のアプリでも下書きは保存される）。 */
const DRAFT = {
  title: "SONY α7 III ボディ＋標準ズームレンズ",
  body: "2023年に購入し、年に数回使いました。シャッター回数は約8,000回です。レンズ（FE 28-70mm）と純正バッテリー2個、充電器、元箱が付属します。室内で保管していたため、目立つ傷や汚れはありません。",
  category: "家電・スマホ・カメラ",
  condition: "目立った傷や汚れなし",
  shippingFee: "送料込み（出品者負担）",
  shippingDays: "2〜3日で発送",
  price: 58000,
};

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

function applyDraft() {
  for (const field of FIELDS) {
    if (form[field]) form[field].value = String(DRAFT[field]);
  }
  document.querySelector("#draft-note").textContent = "前回の下書きを復元しました";
  document.querySelector("#photo-1").classList.add("filled");
  document.querySelector("#preview-image").hidden = false;
  clearErrors();
  sync();
}

function clearDraft() {
  for (const field of FIELDS) {
    if (form[field]) form[field].value = "";
  }
  document.querySelector("#draft-note").textContent = "下書きはありません";
  document.querySelector("#photo-1").classList.remove("filled");
  document.querySelector("#photo-1").textContent = "＋";
  document.querySelector("#preview-image").hidden = true;
  clearErrors();
  sync();
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
  fillSelect("category", meta.options.categories, DRAFT.category);
  fillSelect("condition", meta.options.conditions, DRAFT.condition);
  fillSelect("shippingFee", meta.options.shippingFees, DRAFT.shippingFee);
  fillSelect("shippingDays", meta.options.shippingDays, DRAFT.shippingDays);
  document.querySelector("#fee-rate").textContent = String(Math.round(meta.feeRate * 100));

  form.addEventListener("submit", submitListing);
  form.addEventListener("input", sync);
  form.addEventListener("change", sync);
  document.querySelector("#draft-restore").addEventListener("click", (event) => {
    event.preventDefault();
    applyDraft();
  });
  document.querySelector("#draft-clear").addEventListener("click", (event) => {
    event.preventDefault();
    clearDraft();
  });
  document.querySelector("#again").addEventListener("click", () => {
    done.hidden = true;
    form.hidden = false;
    document.querySelector("#preview-badge").hidden = true;
    clearDraft();
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

  applyDraft();
}

main();
