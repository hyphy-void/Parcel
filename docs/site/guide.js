"use strict";
const form = document.querySelector("#config-form");
const message = document.querySelector("#config-message");
form.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const raw = document.querySelector("#origin").value.trim();
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    )
      throw new Error("请填写不带路径、端口和查询参数的 HTTPS 应用地址。");
    const account = document.querySelector("#account").value.trim();
    const bucket = document.querySelector("#bucket").value.trim();
    if (
      !/^[a-f0-9]{32}$/.test(account) ||
      !/^[a-z0-9][a-z0-9-]{2,62}$/.test(bucket)
    )
      throw new Error("请检查账户 ID 和桶名格式。");
    const cors = [
      {
        AllowedOrigins: [url.origin],
        AllowedMethods: ["GET", "HEAD", "PUT"],
        AllowedHeaders: ["Content-Type", "Range", "X-Amz-Meta-Parcel-Upload"],
        ExposeHeaders: [
          "ETag",
          "Content-Length",
          "Content-Range",
          "Accept-Ranges",
        ],
        MaxAgeSeconds: 3600,
      },
    ];
    document.querySelector("#cors-output").textContent = JSON.stringify(
      cors,
      null,
      2,
    );
    document.querySelector("#vars-output").textContent =
      `PUBLIC_URL=${url.origin}\nR2_ENDPOINT=https://${account}.r2.cloudflarestorage.com\nR2_BUCKET_NAME=${bucket}\nSTORAGE_QUOTA_BYTES=9000000000\nMAX_FILE_BYTES=8589934592\nWORKERS_PLAN=free\nCLEANUP_BATCH_SIZE=1\nACTIVE=false`;
    document.querySelector("#config-result").hidden = false;
    message.textContent = "配置已生成。Access 与三项密钥需要在控制台单独配置。";
  } catch (error) {
    document.querySelector("#config-result").hidden = true;
    message.textContent = error.message;
  }
});
for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(
        document.getElementById(button.dataset.copy).textContent,
      );
      message.textContent = "已复制。";
    } catch {
      message.textContent = "浏览器未允许复制，请选择上方文本手动复制。";
    }
  });
}
