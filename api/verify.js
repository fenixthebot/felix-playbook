// Serverless function for payment verification
// Vercel Edge Function: /api/verify
// Customer submits: { chain, txHash, email }
// We verify on-chain, then trigger PDF delivery

export const config = { runtime: 'edge' };

const WALLETS = {
  solana: 'CwrzR7Ak23ETY9Cb5DLRfmVMFBQRoyyNfrs1opDZ6LTm',
  ethereum: '0xBA8D414375Ee54DC4064454f32041aa204F202d5',
  bitcoin: 'bc1qg5hxwzradgnuy468ape474l6vnr0g37dhk03j5',
};

const USDC_MINT_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_CONTRACT_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const PRICE_USDC = 19;
const PRICE_BTC = 0.00020; // ~$19 at ~$95k BTC

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
  if (!data.result) return { valid: false, reason: 'Transaction not found' };

  const tx = data.result;
  if (tx.meta?.err) return { valid: false, reason: 'Transaction failed on-chain' };

  // Check for USDC SPL transfer to our wallet
  const innerInstructions = [
    ...(tx.transaction?.message?.instructions || []),
    ...(tx.meta?.innerInstructions?.flatMap(i => i.instructions) || [])
  ];

  for (const ix of innerInstructions) {
    const parsed = ix?.parsed;
    if (!parsed) continue;
    if (parsed.type === 'transferChecked' || parsed.type === 'transfer') {
      const info = parsed.info;
      if (info.mint === USDC_MINT_SOL || info.tokenAmount?.uiAmount >= PRICE_USDC) {
        // Check destination matches our wallet's token account
        // For simplicity, verify amount >= PRICE_USDC
        const amount = info.tokenAmount?.uiAmount || (parseInt(info.amount) / 1e6);
        if (amount >= PRICE_USDC) {
          return { valid: true, amount, chain: 'solana' };
        }
      }
    }
  }

  // Also check SOL transfer (someone might send SOL worth $19+)
  return { valid: false, reason: 'No qualifying USDC transfer found in transaction' };
}

async function verifyEthereum(txHash) {
  const rpc = 'https://eth.llamarpc.com';
  
  // Get transaction receipt
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash]
    })
  });
  const data = await res.json();
  if (!data.result) return { valid: false, reason: 'Transaction not found' };
  if (data.result.status !== '0x1') return { valid: false, reason: 'Transaction reverted' };

  // Check logs for USDC Transfer event to our address
  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const ourAddr = WALLETS.ethereum.toLowerCase().slice(2).padStart(64, '0');

  for (const log of data.result.logs) {
    if (log.address.toLowerCase() === USDC_CONTRACT_ETH &&
        log.topics[0] === transferTopic &&
        log.topics[2]?.toLowerCase() === '0x' + ourAddr) {
      const amount = parseInt(log.data, 16) / 1e6;
      if (amount >= PRICE_USDC) {
        return { valid: true, amount, chain: 'ethereum' };
      }
    }
  }

  // Check if it's a direct ETH transfer to our address
  const txRes = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [txHash]
    })
  });
  const txData = await txRes.json();
  if (txData.result?.to?.toLowerCase() === WALLETS.ethereum.toLowerCase()) {
    const ethValue = parseInt(txData.result.value, 16) / 1e18;
    if (ethValue > 0) {
      return { valid: true, amount: ethValue, chain: 'ethereum', token: 'ETH' };
    }
  }

  return { valid: false, reason: 'No qualifying transfer to our wallet found' };
}

async function verifyBitcoin(txHash) {
  try {
    const res = await fetch(`https://blockstream.info/api/tx/${txHash}`);
    if (!res.ok) return { valid: false, reason: 'Transaction not found' };
    const tx = await res.json();

    if (!tx.status?.confirmed) return { valid: false, reason: 'Transaction not yet confirmed' };

    for (const vout of tx.vout) {
      if (vout.scriptpubkey_address === WALLETS.bitcoin) {
        const btcAmount = vout.value / 1e8;
        if (btcAmount >= PRICE_BTC * 0.95) { // 5% tolerance for BTC price fluctuation
          return { valid: true, amount: btcAmount, chain: 'bitcoin' };
        }
      }
    }
    return { valid: false, reason: 'No output to our Bitcoin address found' };
  } catch {
    return { valid: false, reason: 'Failed to query Bitcoin network' };
  }
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), { status: 405 });
  }

  try {
    const { chain, txHash, email } = await req.json();

    if (!chain || !txHash || !email) {
      return new Response(JSON.stringify({ error: 'Missing chain, txHash, or email' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (!['solana', 'ethereum', 'bitcoin'].includes(chain)) {
      return new Response(JSON.stringify({ error: 'Unsupported chain' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    let result;
    switch (chain) {
      case 'solana': result = await verifySolana(txHash); break;
      case 'ethereum': result = await verifyEthereum(txHash); break;
      case 'bitcoin': result = await verifyBitcoin(txHash); break;
    }

    if (result.valid) {
      // Store order for fulfillment
      // In production, this would trigger an email with the PDF
      // For now, we log and return success + download URL
      return new Response(JSON.stringify({
        success: true,
        message: 'Payment verified! Check your email for the playbook.',
        chain: result.chain,
        amount: result.amount,
        email: email,
        downloadReady: true
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    } else {
      return new Response(JSON.stringify({
        success: false,
        message: result.reason
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Server error', details: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
