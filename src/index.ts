import * as dotenv from 'dotenv'
import * as ethers from 'ethers'

import {
  SafeAccountV0_3_0 as SafeAccount,
  MetaTransaction,
  CandidePaymaster,
  getFunctionSelector,
  createCallData,
  WebauthnPublicKey,
  WebauthnSignatureData,
  SignerSignaturePair,
} from "abstractionkit";
import { UserVerificationRequirement, WebAuthnCredentials, extractClientDataFields, extractPublicKey, extractSignature } from './webauthn';


async function main(): Promise<void> {
  //get values from .env
  dotenv.config()
  const chainId = BigInt(process.env.CHAIN_ID as string)
  const bundlerUrl = process.env.BUNDLER_URL as string
  const jsonRpcNodeProvider = process.env.JSON_RPC_NODE_PROVIDER as string
  const paymasterRPC = process.env.PAYMASTER_RPC as string;
  const sponsorshipPolicyId = process.env.SPONSORSHIP_POLICY_ID as string;

  const eoaWallet1 = ethers.Wallet.createRandom();
  const eoaWallet2 = ethers.Wallet.createRandom();

  let smartAccount = SafeAccount.initializeNewAccount(
    [eoaWallet1.address, eoaWallet2.address],
    { threshold: 1 }
  )

  //After the account contract is deployed, no need to call initializeNewAccount
  //let smartAccount = new SafeAccount(accountAddress)

  console.log("Account address(sender) : " + smartAccount.accountAddress)

  const nftContractAddress = "0x9a7af758aE5d7B6aAE84fe4C5Ba67c041dFE5336";
  const mintFunctionSignature = 'mint(address)';
  const mintFunctionSelector = getFunctionSelector(mintFunctionSignature);
  const mintTransactionCallData = createCallData(
    mintFunctionSelector,
    ["address"],
    [smartAccount.accountAddress]
  );
  const mintNFTMetaTx: MetaTransaction = {
    to: nftContractAddress,
    value: 0n,
    data: mintTransactionCallData,
  }

  let userOperation = await smartAccount.createUserOperation(
    [mintNFTMetaTx],
    jsonRpcNodeProvider,
    bundlerUrl,
    {
      expectedSigners: [eoaWallet1.address]
    }
  )

  let paymaster: CandidePaymaster = new CandidePaymaster(
    paymasterRPC,
  )
  let [paymasterUserOperation, sponsorMetadata] = await paymaster.createSponsorPaymasterUserOperation(
    userOperation,
    bundlerUrl,
    sponsorshipPolicyId,
  )
  userOperation = paymasterUserOperation;

  console.log("This transaction gas is sponsored by",sponsorMetadata?.name)

  console.log("EOA Owner 1 signing transaction...");
  userOperation.signature = smartAccount.signUserOperation(userOperation, [eoaWallet1.privateKey], chainId);
  const sendUserOperationResponse = await smartAccount.sendUserOperation(
    userOperation, bundlerUrl
  )

  console.log("Useroperation sent. Waiting to be included ......");
  let userOperationReceiptResult = await sendUserOperationResponse.included()

  console.log("Useroperation receipt received.")
  console.log(userOperationReceiptResult)
  if (userOperationReceiptResult.success) {
    console.log("Safe Account deployed with two EOA owners and an NFT is minted. The transaction hash is : " + userOperationReceiptResult.receipt.transactionHash)
  } else {
    console.log("Useroperation execution failed")
  }

  // Swap owners to a webAuthn Owner
  const navigator = {
    credentials: new WebAuthnCredentials(),
  }

  const credential = navigator.credentials.create({
    publicKey: {
      rp: {
        name: 'Safe',
        id: 'safe.global',
      },
      user: {
        id: ethers.getBytes(ethers.id('chucknorris')),
        name: 'chucknorris',
        displayName: 'Chuck Norris',
      },
      challenge: ethers.toBeArray(Date.now()),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    },
  })


  const publicKey = extractPublicKey(credential.response)

  const webauthPublicKey: WebauthnPublicKey = {
    x: publicKey.x,
    y: publicKey.y,
  }

  console.log("Swapping EOA2 Owner with WebAuthn Owner");
  const swapOwnerMetaTx = await smartAccount.createSwapOwnerMetaTransactions(jsonRpcNodeProvider, webauthPublicKey, eoaWallet2.address);

  let userOperation2 = await smartAccount.createUserOperation(
    swapOwnerMetaTx,
    jsonRpcNodeProvider,
    bundlerUrl,
    {
      expectedSigners: [eoaWallet1.address]
    }
  )

  let [paymasterUserOperation2, sponsorMetaData2] = await paymaster.createSponsorPaymasterUserOperation(
    userOperation2,
    bundlerUrl,
    sponsorshipPolicyId,
  )
  userOperation2 = paymasterUserOperation2;
  console.log("This transaction gas is sponsored by", sponsorMetaData2?.name);

  console.log("EOA1 is signing this transaction...")
  userOperation2.signature = smartAccount.signUserOperation(userOperation2, [eoaWallet1.privateKey], chainId);
  const sendUserOperationResponse2 = await smartAccount.sendUserOperation(
    userOperation2, bundlerUrl
  )

  console.log("Useroperation sent. Waiting to be included ......")
  //included will return a UserOperationReceiptResult when 
  //useroperation is included onchain
  let userOperationReceiptResult2 = await sendUserOperationResponse2.included()

  console.log("Useroperation receipt received.")
  console.log(userOperationReceiptResult2)
  if (userOperationReceiptResult2.success) {
    console.log("EOA2 Owner Swapped with WebAuthn Owner. Transaction hash is : " + userOperationReceiptResult2.receipt.transactionHash)
  } else {
    console.log("Useroperation execution failed")
  }


  // Mint NFT and sign uwerOp with webAuthn Owner

  let userOperation3 = await smartAccount.createUserOperation(
    [mintNFTMetaTx],
    jsonRpcNodeProvider, //the node rpc is used to fetch the current nonce and fetch gas prices.
    bundlerUrl, //the bundler rpc is used to estimate the gas limits.
    {
      expectedSigners: [webauthPublicKey],
    }
  )

  let [paymasterUserOperation3, sponsorMetaData3] = await paymaster.createSponsorPaymasterUserOperation(
    userOperation3,
    bundlerUrl,
    sponsorshipPolicyId,
  )
  userOperation3 = paymasterUserOperation3;

  console.log("This transaction gas is sponsored by", sponsorMetaData3?.name);

  console.log("WebAuthn Owner is signing this transaction...")
  const safeInitOpHash3 = SafeAccount.getUserOperationEip712Hash(
    userOperation3,
    chainId,
  )

  const assertion = navigator.credentials.get({
    publicKey: {
      challenge: ethers.getBytes(safeInitOpHash3),
      rpId: 'safe.global',
      allowCredentials: [{ type: 'public-key', id: new Uint8Array(credential.rawId) }],
      userVerification: UserVerificationRequirement.required,
    },
  })

  const webauthSignatureData: WebauthnSignatureData = {
    authenticatorData: assertion.response.authenticatorData,
    clientDataFields: extractClientDataFields(assertion.response),
    rs: extractSignature(assertion.response),
  }

  const webauthSignature: string = SafeAccount.createWebAuthnSignature(
    webauthSignatureData
  )

  const signerSignaturePair: SignerSignaturePair = {
    signer: webauthPublicKey,
    signature: webauthSignature,
  }

  userOperation3.signature = SafeAccount.formatSignaturesToUseroperationSignature(
    [signerSignaturePair],
    { isInit: userOperation3.nonce == 0n }
  )

  const sendUserOperationResponse3 = await smartAccount.sendUserOperation(
    userOperation3, bundlerUrl
  )

  console.log("Useroperation sent. Waiting to be included ......")
  let userOperationReceiptResult3 = await sendUserOperationResponse3.included()

  console.log("Useroperation receipt received.")
  console.log(userOperationReceiptResult3)
  if (userOperationReceiptResult3.success) {
    console.log("An Nfts were minted, signed by WebAuthn Owner. The transaction hash is : " + userOperationReceiptResult3.receipt.transactionHash)
  } else {
    console.log("Useroperation execution failed")
  }

}

main()
