/*
 * $CHRONIC — shared wallet helpers. Single source of truth for SIGNING.
 *
 * RULE (do not break): never call provider.signTransaction() then
 * sendRawTransaction() directly for submission. ALWAYS submit through
 * chronicSignAndSend(), which prefers provider.signAndSendTransaction so the
 * wallet signs AND submits the exact transaction the user approved.
 *
 * Why: Phantom support confirmed that the bare sign-then-send-separately
 * pattern (signTransaction + sendRawTransaction) trips Blowfish's
 * "this dApp could be malicious" warning, even for a benign SPL burn from the
 * user's own ATA. signAndSendTransaction gives Phantom full context and clears
 * the warning. The signTransaction path below is ONLY a fallback for wallets
 * that don't implement signAndSendTransaction.
 *
 * Usage (any page):
 *   <script src="/assets/wallet.js"></script>
 *   const sig = await chronicSignAndSend(provider, tx, connection);
 *   // tx: Transaction | VersionedTransaction (may be partially pre-signed)
 *   // connection: only needed for the legacy fallback
 */
(function (g) {
  async function chronicSignAndSend(provider, tx, connection) {
    if (!provider) throw new Error('wallet not connected');
    if (provider.signAndSendTransaction) {
      const r = await provider.signAndSendTransaction(tx);
      return r && (r.signature || r);
    }
    // fallback: wallets without signAndSendTransaction
    if (!connection) throw new Error('connection required for fallback send');
    const signed = await provider.signTransaction(tx);
    return await connection.sendRawTransaction(signed.serialize());
  }
  g.chronicSignAndSend = chronicSignAndSend;
})(typeof window !== 'undefined' ? window : globalThis);
