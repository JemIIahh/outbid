// Displays the recorded mainnet purchase. Loading this page cannot sign or spend.
async function showEvidence() {
  const responses = await Promise.all([fetch("fixtures/buy-proof.json"), fetch("fixtures/agent-registration.json")]);
  if (responses.some(response => !response.ok)) return;
  const [proof, agent] = await Promise.all(responses.map(response => response.json()));
  const hash = /^0x[0-9a-f]{64}$/i;
  if (proof.chainId !== 42220 || agent.chainId !== 42220 || proof.settlementVerified !== true || proof.receipt?.outcome !== "confirmed" || !hash.test(proof.receipt.txHash) || !hash.test(agent.transactionHash)) return;
  const text = (id, value) => { document.getElementById(id).textContent = value; };
  text("evidence-input", proof.task.input);
  text("evidence-output", proof.output);
  text("evidence-amount", `${(Number(proof.receipt.amount) / 1e6).toFixed(2)} ${proof.quote.token}`);
  const payment = document.getElementById("evidence-payment");
  payment.href = `https://celoscan.io/tx/${proof.receipt.txHash}`;
  const identity = document.getElementById("evidence-identity");
  identity.textContent = `ERC-8004 #${agent.agentId} ↗`;
  identity.href = `https://celoscan.io/tx/${agent.transactionHash}`;
  document.getElementById("mainnet-evidence").hidden = false;
}
showEvidence().catch(() => { /* Evidence is optional; never mislabel missing proof. */ });
