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
  /*
   * MULTI-SIGNER transactions (e.g. a token launch where a new mint keypair
   * also signs) must NOT use signAndSendTransaction. Per Phantom's docs, sign
   * with Phantom via signTransaction, combine with the other signatures, then
   * submit yourself. Use chronicSignAndSend ONLY for single-signer txs.
   */

  /*
   * Simulate a tx with sigVerify:false BEFORE asking the user to sign, so it
   * won't fail on-chain (Phantom recommends this). Best-effort: returns ok on
   * any simulation-infrastructure error so it never blocks a valid trade; only
   * returns {ok:false} when the RPC reports a definite execution error.
   */
  async function chronicSimulate(connection, tx) {
    try {
      const r = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
      if (r && r.value && r.value.err) return { ok: false, err: r.value.err, logs: (r.value.logs || []) };
    } catch (_) { /* legacy overload / infra hiccup — don't block */ }
    return { ok: true };
  }

  g.chronicSignAndSend = chronicSignAndSend;
  g.chronicSimulate = chronicSimulate;
})(typeof window !== 'undefined' ? window : globalThis);
