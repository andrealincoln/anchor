const anchor = require("@project-serum/anchor");
const serumCmn = require("@project-serum/common");
const TokenInstructions = require("@project-serum/serum").TokenInstructions;
const utils = require("../../deps/stake/tests/utils");

const lockup = anchor.workspace.Lockup;
const registry = anchor.workspace.Registry;
const provider = anchor.Provider.env();

const withdrawalTimelock = new anchor.BN(4);
const stakeRate = new anchor.BN(2);
const rewardQLen = 170;

const WHITELIST_SIZE = 10;

async function setupStakePool(mint, god) {
	const registrar = new anchor.web3.Account();
	const rewardQ = new anchor.web3.Account();

  // Registry genesis.
  const [
    registrarSigner,
    nonce,
  ] = await anchor.web3.PublicKey.findProgramAddress(
    [registrar.publicKey.toBuffer()],
    registry.programId
  );
  const poolMint = await serumCmn.createMint(provider, registrarSigner);

  try {
    // Init registry.
    await registry.state.rpc.new({
      accounts: { lockupProgram: lockup.programId },
    });

    // Init lockup.
    await lockup.state.rpc.new({
      accounts: {
        authority: provider.wallet.publicKey,
      },
    });
  } catch (err) {
    // Skip errors for convenience when developing locally,
    // since the state constructors can only be called once.
  }

  // Initialize stake pool.
  await registry.rpc.initialize(
    mint,
    provider.wallet.publicKey,
    nonce,
    withdrawalTimelock,
    stakeRate,
    rewardQLen,
    {
      accounts: {
        registrar: registrar.publicKey,
        poolMint,
        rewardEventQ: rewardQ.publicKey,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      },
      signers: [registrar, rewardQ],
      instructions: [
        await registry.account.registrar.createInstruction(registrar),
        await registry.account.rewardQueue.createInstruction(rewardQ, 8250),
      ],
    }
  );
  const registrarAccount = await registry.account.registrar.fetch(
    registrar.publicKey
  );
  console.log("Registrar", registrar.publicKey.toString());
  console.log("Wallet", registry.provider.wallet.publicKey.toString());
  // Create account for staker.
  const seed = anchor.utils.sha256
    .hash(`${registrar.publicKey.toString()}:Member`)
    .slice(0, 32);
  const member = await anchor.web3.PublicKey.createWithSeed(
    registry.provider.wallet.publicKey,
    seed,
    registry.programId
  );
  const [
    memberSigner,
    nonce2,
  ] = await anchor.web3.PublicKey.findProgramAddress(
    [registrar.publicKey.toBuffer(), member.toBuffer()],
    registry.programId
  );
  const [mainTx, balances] = await utils.createBalanceSandbox(
    provider,
    registrarAccount,
    memberSigner
  );
  const [lockedTx, balancesLocked] = await utils.createBalanceSandbox(
    provider,
    registrarAccount,
    memberSigner
  );
  const tx = registry.transaction.createMember(nonce2, {
    accounts: {
      registrar: registrar.publicKey,
      member: member,
      beneficiary: provider.wallet.publicKey,
      memberSigner,
      balances,
      balancesLocked,
      tokenProgram: TokenInstructions.TOKEN_PROGRAM_ID,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    },
    instructions: [
      anchor.web3.SystemProgram.createAccountWithSeed({
        fromPubkey: registry.provider.wallet.publicKey,
        newAccountPubkey: member,
        basePubkey: registry.provider.wallet.publicKey,
        seed,
        lamports: await registry.provider.connection.getMinimumBalanceForRentExemption(
          registry.account.member.size
        ),
        space: registry.account.member.size,
        programId: registry.programId,
      }),
    ],
  });
  const signers = [provider.wallet.payer];
  const allTxs = [mainTx, lockedTx, { tx, signers }];
  await provider.sendAll(allTxs);
  const memberAccount = await registry.account.member.fetch(member);

  // Deposit into stake program.
  const depositAmount = new anchor.BN(120);
  await registry.rpc.deposit(depositAmount, {
    accounts: {
      depositor: god,
      depositorAuthority: provider.wallet.publicKey,
      tokenProgram: TokenInstructions.TOKEN_PROGRAM_ID,
      vault: memberAccount.balances.vault,
      beneficiary: provider.wallet.publicKey,
      member: member,
    },
  });

  // Stake.
  const stakeAmount = new anchor.BN(10);
  await registry.rpc.stake(stakeAmount, false, {
    accounts: {
      // Stake instance.
      registrar: registrar.publicKey,
      rewardEventQ: rewardQ.publicKey,
      poolMint,
      // Member.
      member: member,
      beneficiary: provider.wallet.publicKey,
      balances,
      balancesLocked,
      // Program signers.
      memberSigner,
      registrarSigner,
      // Misc.
      clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      tokenProgram: TokenInstructions.TOKEN_PROGRAM_ID,
    },
  });

		return {
				registrar: registrar.publicKey,
				poolMint,
				rewardEventQ: rewardQ.publicKey,
				member,
		};
}

module.exports = {
  setupStakePool,
};