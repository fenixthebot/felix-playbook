// Vercel Serverless Function: /api/verify
// Customer submits: { chain, txHash, email }
// We verify on-chain, then confirm for PDF delivery

const WALLETS = {
  solana: 'CwrzR7Ak23ETY9Cb5DLRfmVMFBQRoyyNfrs1opDZ6LTm',
  ethereum: '0xBA8D414375Ee54DC4064454f32041aa204F202d5',
  bitcoin: 'bc1qg5hxwzradgnuy468ape474l6vnr0g37dhk03j5',
};

const USDC_MINT_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_CONTRACT_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const PRICE_USDC = 19;
const PRICE_BTC = 0.00019;

async function verifySolana(txHash) {
  const rpc = 'https://api.mainnet-beta.solana.com';
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getTransaction',
      params: [txHash, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
    })
  });
  const data = await res.json();
  if (!data.result) return { valid: false, reason: 'Transaction not found. It may still be processing — try again in a minute.' };
  if (data.result.meta?.err) return { valid: false, reason: 'Transaction failed on-chain.' };

  const allIx = [
    ...(data.result.transaction?.message?.instructions || []),
    ...(data.result.meta?.innerInstructions?.flatMap(i => i.instructions) || [])
  ];

  for (const ix of allIx) {
    const parsed = ix?.parsed;
    if (!parsed) continue;
    if (parsed.type === 'transferChecked' || parsed.type === 'transfer') {
      const info = parsed.info;
      const amount = info.tokenAmount?.uiAmount || (parseInt(info.amount || '0') / 1e6);
      if (amount >= PRICE_USDC * 0.95) {
        return { valid: true, amount, chain: 'solana' };
      }
    }
  }
  return { valid: false, reason: 'No qualifying USDC transfer found in this transaction.' };
}

async function verifyEthereum(txHash) {
  const rpc = 'https://eth.llamarpc.com';
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] })
  });
  const data = await res.json();
  if (!data.result) return { valid: false, reason: 'Transaction not found. It may still be confirming.' };
  if (data.result.status !== '0x1') return { valid: false, reason: 'Transaction reverted on-chain.' };

  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const ourAddr = WALLETS.ethereum.toLowerCase().slice(2).padStart(64, '0');

  for (const log of data.result.logs) {
    if (log.address.toLowerCase() === USDC_CONTRACT_ETH &&
        log.topics[0] === transferTopic &&
        log.topics[2]?.toLowerCase() === '0x' + ourAddr) {
      const amount = parseInt(log.data, 16) / 1e6;
      if (amount >= PRICE_USDC * 0.95) {
        return { valid: true, amount, chain: 'ethereum' };
      }
    }
  }

  const txRes = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [txHash] })
  });
  const txData = await txRes.json();
  if (txData.result?.to?.toLowerCase() === WALLETS.ethereum.toLowerCase()) {
    const ethValue = parseInt(txData.result.value, 16) / 1e18;
    if (ethValue > 0.005) {
      return { valid: true, amount: ethValue, chain: 'ethereum', token: 'ETH' };
    }
  }

  return { valid: false, reason: 'No qualifying transfer to our wallet found.' };
}

async function verifyBitcoin(txHash) {
  try {
    const res = await fetch(`https://blockstream.info/api/tx/${txHash}`);
    if (!res.ok) return { valid: false, reason: 'Transaction not found on Bitcoin network.' };
    const tx = await res.json();
    if (!tx.status?.confirmed) return { valid: false, reason: 'Transaction not yet confirmed. Please wait for at least 1 confirmation.' };

    for (const vout of tx.vout) {
      if (vout.scriptpubkey_address === WALLETS.bitcoin) {
        const btcAmount = vout.value / 1e8;
        if (btcAmount >= PRICE_BTC * 0.9) {
          return { valid: true, amount: btcAmount, chain: 'bitcoin' };
        }
      }
    }
    return { valid: false, reason: 'No output to our Bitcoin address found in this transaction.' };
  } catch {
    return { valid: false, reason: 'Failed to query Bitcoin network. Try again shortly.' };
  }
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { chain, txHash, email } = req.body;

    if (!chain || !txHash || !email) {
      return res.status(400).json({ error: 'Missing chain, txHash, or email' });
    }

    if (!['solana', 'ethereum', 'bitcoin'].includes(chain)) {
      return res.status(400).json({ error: 'Unsupported chain. Use: solana, ethereum, or bitcoin' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    let result;
    switch (chain) {
      case 'solana': result = await verifySolana(txHash); break;
      case 'ethereum': result = await verifyEthereum(txHash); break;
      case 'bitcoin': result = await verifyBitcoin(txHash); break;
    }

    if (result.valid) {
      return res.status(200).json({
        success: true,
        message: 'Payment verified! Your playbook will be sent to ' + email + ' shortly.',
        chain: result.chain,
        amount: result.amount,
        email,
        verifiedAt: new Date().toISOString()
      });
    } else {
      return res.status(400).json({
        success: false,
        message: result.reason
      });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Server error', details: err.message });
  }
};
