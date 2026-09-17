// 利用者向けの普通の投稿フォーム。
// JEV の存在・確率・条件 ID は一切出しません（裏側の話は /ops だけ）。
const form = document.querySelector("#form");
const alertBox = document.querySelector("#alert");
const done = document.querySelector("#done");
const submit = document.querySelector("#submit");

const FIELDS = ["nickname", "rating", "title", "body", "email"];

function clearErrors() {
  alertBox.hidden = true;
  alertBox.textContent = "";
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

  alertBox.textContent =
    unplaced.length > 0 ? `入力内容をご確認ください。${unplaced.join(" ")}` : "入力内容をご確認ください。";
  alertBox.hidden = false;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearErrors();
  submit.disabled = true;
  submit.textContent = "送信中…";

  try {
    const response = await fetch("/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nickname: form.nickname.value,
        rating: form.rating.value,
        title: form.title.value,
        body: form.body.value,
        email: form.email.value,
      }),
    });
    const data = await response.json();

    if (response.status === 422) {
      showErrors(data.fieldErrors, data.formErrors);
      return;
    }
    if (!response.ok) throw new Error(data.error ?? "送信に失敗しました");

    form.hidden = true;
    done.hidden = false;
    document.querySelector("#receipt-id").textContent = data.id;
    document.querySelector("#receipt-note").textContent =
      data.status === "review"
        ? "内容を確認させていただく場合があります。確認でき次第、掲載します。"
        : "内容を確認のうえ、順次掲載します。";
  } catch (error) {
    alertBox.textContent = `送信に失敗しました。時間をおいてお試しください。（${String(error.message ?? error)}）`;
    alertBox.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = "レビューを投稿する";
  }
});
