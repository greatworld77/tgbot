import { getDb } from "../lib/db.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const RECEIVER_WALLET = process.env.RECEIVER_WALLET.toLowerCase();
const MINT_PRICE_ETH = process.env.MINT_PRICE_ETH;
const DELIVERY_TIME = process.env.DELIVERY_TIME || "24 hours";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const CHAIN_ID = process.env.CHAIN_ID || "11155111";

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function sendMessage(chatId, text) {
  await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML"
    })
  });
}

async function verifyPayment(txHash) {
  const txUrl =
    `https://api.etherscan.io/v2/api?chainid=${CHAIN_ID}&module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${ETHERSCAN_API_KEY}`;

  const receiptUrl =
    `https://api.etherscan.io/v2/api?chainid=${CHAIN_ID}&module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}&apikey=${ETHERSCAN_API_KEY}`;

  const txRes = await fetch(txUrl);
  const txData = await txRes.json();

  const receiptRes = await fetch(receiptUrl);
  const receiptData = await receiptRes.json();

  const tx = txData.result;
  const receipt = receiptData.result;

  if (!tx) return { ok: false, reason: "Transaction not found." };
  if (!receipt) return { ok: false, reason: "Transaction is not confirmed yet." };
  if (receipt.status !== "0x1") return { ok: false, reason: "Transaction failed." };

  if (!tx.to || tx.to.toLowerCase() !== RECEIVER_WALLET) {
    return { ok: false, reason: "Payment was not sent to the correct wallet." };
  }

  const paidWei = BigInt(tx.value);
  const requiredWei = BigInt(Math.floor(Number(MINT_PRICE_ETH) * 1e18));

  if (paidWei < requiredWei) {
    return { ok: false, reason: "Payment amount is too low." };
  }

  return {
    ok: true,
    amountEth: Number(paidWei) / 1e18
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("NFT Telegram Bot is running.");
  }

  const db = await getDb();
  const orders = db.collection("orders");

  const message = req.body.message;
  if (!message) return res.status(200).json({ ok: true });

  const chatId = message.chat.id;
  const username = message.from.username ? `@${message.from.username}` : "No username";

  let existingOrder = await orders.findOne({
    telegramId: chatId,
    status: { $in: ["image_received", "waiting_payment"] }
  });

  if (message.text === "/start") {
    await orders.updateMany(
      { telegramId: chatId, status: { $in: ["image_received", "waiting_payment"] } },
      { $set: { status: "cancelled" } }
    );

    await sendMessage(
      chatId,
      `👋 Welcome to the NFT Mint Bot!

How to use this bot:

1. Upload your NFT image.
2. Pay the mint price.
3. Send your transaction hash.
4. Your NFT will be delivered within ${DELIVERY_TIME}.

Please upload your image now.`
    );

    return res.status(200).json({ ok: true });
  }

  if (message.photo || message.document) {
    let imageFileId = "";

    if (message.photo) {
      imageFileId = message.photo[message.photo.length - 1].file_id;
    }

    if (message.document) {
      imageFileId = message.document.file_id;
    }

    await orders.insertOne({
      telegramId: chatId,
      username,
      imageFileId,
      txHash: null,
      paymentVerified: false,
      status: "waiting_payment",
      createdAt: new Date()
    });

    await sendMessage(
      chatId,
      `✅ Image received successfully.

Mint Price: ${MINT_PRICE_ETH} Sepolia ETH

Send payment to this EVM address:

<code>${RECEIVER_WALLET}</code>

After payment, send your transaction hash here.`
    );

    await sendMessage(
      ADMIN_CHAT_ID,
      `📸 New image received

User: ${username}
Telegram ID: ${chatId}

Image File ID:
${imageFileId}

Waiting for payment.`
    );

    return res.status(200).json({ ok: true });
  }

  if (message.text && message.text.startsWith("0x") && message.text.length >= 60) {
    const txHash = message.text.trim().toLowerCase();

    const usedTx = await orders.findOne({ txHash });

    if (usedTx) {
      await sendMessage(
        chatId,
        `❌ This transaction hash has already been used.

Please send a new valid transaction hash.`
      );

      return res.status(200).json({ ok: true });
    }

    if (!existingOrder) {
      await sendMessage(
        chatId,
        `Please upload your image first.

After image upload, I will give you the payment address.`
      );

      return res.status(200).json({ ok: true });
    }

    await sendMessage(chatId, "🔎 Checking your payment...");

    const result = await verifyPayment(txHash);

    if (!result.ok) {
      await sendMessage(
        chatId,
        `❌ Payment verification failed.

Reason: ${result.reason}

Please check your transaction hash and send it again.`
      );

      return res.status(200).json({ ok: true });
    }

    await orders.updateOne(
      { _id: existingOrder._id },
      {
        $set: {
          txHash,
          paymentVerified: true,
          amountEth: result.amountEth,
          status: "paid_pending_delivery",
          paidAt: new Date()
        }
      }
    );

    await sendMessage(
      chatId,
      `✅ Payment received successfully.

Your NFT is now generating and will be delivered within ${DELIVERY_TIME}.`
    );

    await sendMessage(
      ADMIN_CHAT_ID,
      `🚀 New Paid Mint Order

User: ${username}
Telegram ID: ${chatId}

Image File ID:
${existingOrder.imageFileId}

TX Hash:
${txHash}

Amount:
${result.amountEth} Sepolia ETH

Status:
Payment Verified ✅`
    );

    return res.status(200).json({ ok: true });
  }

  await sendMessage(chatId, "Please upload an image to begin.");

  return res.status(200).json({ ok: true });
}
