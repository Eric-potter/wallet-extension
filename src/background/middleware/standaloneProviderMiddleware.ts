import { NekotonRpcError, RpcErrorCode, StandaloneNekoton } from '@app/models';
import type { JsonRpcMiddleware, UniqueArray } from '@app/shared';
import { JsonRpcApiClient } from '@app/shared';
import manifest from '@app/static/manifest.json';
import type { KnownPayload } from '@wallet/nekoton-wasm';
import type { Permission, RawProviderApi } from 'everscale-inpage-provider';
import { nanoid } from 'nanoid';
import type * as nt from 'nekoton-wasm';
import { ApprovalController } from '../controllers/ApprovalController';
import { PermissionsController } from '../controllers/PermissionsController';
import { StandaloneConnectionController } from '../controllers/StandaloneConnectionController';
import { StandaloneSubscriptionController } from '../controllers/StandaloneSubscriptionController';
import type { HelperMiddlewareApi } from './helperMiddleware';
import {
  invalidRequest,
  requireArray,
  requireAssetTypeParams,
  requireBoolean,
  requireContractState,
  requireFunctionCall,
  requireMethodOrArray,
  requireObject,
  requireOptional,
  requireOptionalBoolean,
  requireOptionalNumber,
  requireOptionalObject,
  requireOptionalString,
  requireParams,
  requireString,
  requireTransactionId,
} from './utils';

interface CreateProviderMiddlewareOptions {
  origin: string;
  jrpcClient: JsonRpcApiClient<HelperMiddlewareApi>;
  nekoton: StandaloneNekoton;
  clock: nt.ClockWithOffset,
  approvalController: ApprovalController;
  connectionController: StandaloneConnectionController;
  permissionsController: PermissionsController;
  subscriptionsController: StandaloneSubscriptionController;
}

type ProviderMethod<T extends keyof RawProviderApi> = RawProviderApi[T] extends { input?: infer I, output?: infer O }
  ? (
    ...args: [
      ...Parameters<JsonRpcMiddleware<I extends undefined ? {} : I, O extends undefined ? {} : O>>,
      CreateProviderMiddlewareOptions,
    ]
  ) => Promise<void>
  : never;

// helper methods:
//

function requirePermissions<P extends Permission>(
  { origin, permissionsController }: CreateProviderMiddlewareOptions,
  permissions: UniqueArray<P>[],
) {
  permissionsController.checkPermissions(origin, permissions);
}

// Provider api
//

const requestPermissions: ProviderMethod<'requestPermissions'> = async (
  req,
  res,
  _next,
  end,
  { origin, permissionsController },
) => {
  requireParams(req);

  const { permissions } = req.params;
  requireArray(req, req.params, 'permissions');

  res.result = await permissionsController.requestPermissions(origin, permissions as Permission[]);
  end();
};

const changeAccount: ProviderMethod<'changeAccount'> = async (_req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['accountInteraction']);

  const { origin, permissionsController } = ctx;

  res.result = await permissionsController.changeAccount(origin);
  end();
};

const disconnect: ProviderMethod<'disconnect'> = async (_req, res, _next, end, ctx) => {
  const { origin, permissionsController, subscriptionsController } = ctx;

  await permissionsController.removeOrigin(origin);
  await subscriptionsController.unsubscribeFromAllContracts();

  res.result = {};
  end();
};

const subscribe: ProviderMethod<'subscribe'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['basic']);
  requireParams(req);

  const { address, subscriptions } = req.params;
  requireString(req, req.params, 'address');
  requireOptionalObject(req, req.params, 'subscriptions');

  if (!ctx.nekoton.checkAddress(address)) {
    throw invalidRequest(req, 'Invalid address');
  }

  const { subscriptionsController } = ctx;

  res.result = await subscriptionsController.subscribeToContract(address, subscriptions);
  end();
};

const unsubscribe: ProviderMethod<'unsubscribe'> = async (req, res, _next, end, ctx) => {
  requireParams(req);

  const { address } = req.params;
  requireString(req, req.params, 'address');

  if (!ctx.nekoton.checkAddress(address)) {
    throw invalidRequest(req, 'Invalid address');
  }

  const { subscriptionsController } = ctx;

  await subscriptionsController.unsubscribeFromContract(address);
  res.result = {};
  end();
};

const unsubscribeAll: ProviderMethod<'unsubscribeAll'> = async (req, res, _next, end, ctx) => {
  const { subscriptionsController } = ctx;

  await subscriptionsController.unsubscribeFromAllContracts();

  res.result = {};
  end();
};

const getProviderState: ProviderMethod<'getProviderState'> = async (
  _req,
  res,
  _next,
  end,
  { origin, connectionController, permissionsController, subscriptionsController },
) => {
  const { selectedConnection } = connectionController.state;
  const permissions = permissionsController.getPermissions(origin);

  const convertVersionToInt32 = (version: string): number => {
    const parts = version.split('.');
    if (parts.length !== 3) {
      throw new Error('Received invalid version string');
    }

    parts.forEach((part) => {
      if (~~part > 999) {
        throw new Error(`Version string invalid, ${part} is too large`);
      }
    });

    let multiplier = 1000000;
    let numericVersion = 0;
    for (let i = 0; i < 3; i++) {
      numericVersion += ~~parts[i] * multiplier;
      multiplier /= 1000;
    }
    return numericVersion;
  };

  const version = (manifest as any).version;

  res.result = {
    version,
    numericVersion: convertVersionToInt32(version),
    selectedConnection: selectedConnection.group,
    supportedPermissions: ['basic', 'accountInteraction'],
    permissions,
    subscriptions: subscriptionsController.getTabSubscriptions(),
  };
  end();
};

const getFullContractState: ProviderMethod<'getFullContractState'> = async (
  req,
  res,
  _next,
  end,
  ctx,
) => {
  requirePermissions(ctx, ['basic']);
  requireParams(req);

  const { address } = req.params;
  requireString(req, req.params, 'address');

  const { connectionController } = ctx;

  try {
    res.result = {
      state: await connectionController.use(
        async ({ data: { transport } }) => transport.getFullContractState(address),
      ),
    };
    end();
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const getAccountsByCodeHash: ProviderMethod<'getAccountsByCodeHash'> = async (
  req,
  res,
  _next,
  end,
  ctx,
) => {
  requirePermissions(ctx, ['basic']);
  requireParams(req);

  const { codeHash, limit, continuation } = req.params;
  requireString(req, req.params, 'codeHash');
  requireOptionalNumber(req, req.params, 'limit');
  requireOptionalString(req, req.params, 'continuation');

  const { connectionController } = ctx;

  try {
    res.result = await connectionController.use(
      async ({ data: { transport } }) => transport.getAccountsByCodeHash(codeHash, limit || 50, continuation),
    );
    end();
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const getTransactions: ProviderMethod<'getTransactions'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['basic']);
  requireParams(req);

  const { address, continuation, limit } = req.params;
  requireString(req, req.params, 'address');
  requireOptional(req, req.params, 'continuation', requireTransactionId);
  requireOptionalNumber(req, req.params, 'limit');

  const { connectionController } = ctx;

  try {
    res.result = await connectionController.use(
      async ({ data: { transport } }) => transport.getTransactions(address, continuation?.lt, limit || 50),
    );

    end();
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const getTransaction: ProviderMethod<'getTransaction'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['basic']);
  requireParams(req);

  const { hash } = req.params;
  requireString(req, req.params, 'hash');

  const { connectionController } = ctx;

  try {
    res.result = {
      transaction: await connectionController.use(
        async ({ data: { transport } }) => transport.getTransaction(hash),
      ),
    };

    end();
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const runLocal: ProviderMethod<'runLocal'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['basic']);
  requireParams(req);

  const { address, cachedState, responsible, functionCall } = req.params;
  requireString(req, req.params, 'address');
  requireOptional(req, req.params, 'cachedState', requireContractState);
  requireOptionalBoolean(req, req.params, 'responsible');
  requireFunctionCall(req, req.params, 'functionCall');

  const { clock, connectionController } = ctx;

  let contractState = cachedState;

  if (contractState == null) {
    contractState = await connectionController.use(
      async ({ data: { transport } }) => transport.getFullContractState(address),
    );
  }

  if (contractState == null) {
    throw invalidRequest(req, 'Account not found');
  }
  if (!contractState.isDeployed || contractState.lastTransactionId == null) {
    throw invalidRequest(req, 'Account is not deployed');
  }

  try {
    const { output, code } = ctx.nekoton.runLocal(
      clock,
      contractState.boc,
      functionCall.abi,
      functionCall.method,
      functionCall.params,
      responsible || false,
    );

    res.result = {
      output,
      code,
    };
    end();
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const getExpectedAddress: ProviderMethod<'getExpectedAddress'> = async (
  req,
  res,
  _next,
  end,
  ctx,
) => {
  requirePermissions(ctx, ['basic']);
  requireParams(req);

  const { tvc, abi, workchain, publicKey, initParams } = req.params;
  requireString(req, req.params, 'tvc');
  requireString(req, req.params, 'abi');
  requireOptionalNumber(req, req.params, 'workchain');
  requireOptionalString(req, req.params, 'publicKey');

  try {
    res.result = ctx.nekoton.getExpectedAddress(tvc, abi, workchain || 0, publicKey, initParams);
    end();
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const getBocHash: ProviderMethod<'getBocHash'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['basic']);
  requireParams(req);

  const { boc } = req.params;
  requireString(req, req.params, 'boc');

  try {
    res.result = {
      hash: ctx.nekoton.getBocHash(boc),
    };
    end();
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const packIntoCell: ProviderMethod<'packIntoCell'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['basic']);
  requireParams(req);

  const { structure, data } = req.params;
  requireArray(req, req.params, 'structure');

  try {
    res.result = {
      boc: ctx.nekoton.packIntoCell(structure as nt.AbiParam[], data),
    };
    end();
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const unpackFromCell: ProviderMethod<'unpackFromCell'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['basic']);
  requireParams(req);

  const { structure, boc, allowPartial } = req.params;
  requireArray(req, req.params, 'structure');
  requireString(req, req.params, 'boc');
  requireBoolean(req, req.params, 'allowPartial');

  try {
    res.result = {
      data: ctx.nekoton.unpackFromCell(structure as nt.AbiParam[], boc, allowPartial),
    };
    end();
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const extractPublicKey: ProviderMethod<'extractPublicKey'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['basic']);
  requireParams(req);

  const { boc } = req.params;
  requireString(req, req.params, 'boc');

  try {
    res.result = {
      publicKey: ctx.nekoton.extractPublicKey(boc),
    };
    end();
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const codeToTvc: ProviderMethod<'codeToTvc'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['basic']);
  requireParams(req);

  const { code } = req.params;
  requireString(req, req.params, 'code');

  try {
    res.result = {
      tvc: ctx.nekoton.codeToTvc(code),
    };
    end();
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const mergeTvc: ProviderMethod<'mergeTvc'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['basic']);
  requireParams(req);

  const { code, data } = req.params;
  requireString(req, req.params, 'code');
  requireString(req, req.params, 'data');

  try {
    res.result = {
      tvc: ctx.nekoton.mergeTvc(code, data),
    };
    end();
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const splitTvc: ProviderMethod<'splitTvc'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['basic']);
  requireParams(req);

  const { tvc } = req.params;
  requireString(req, req.params, 'tvc');

  try {
    res.result = ctx.nekoton.splitTvc(tvc);
    end();
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const setCodeSalt: ProviderMethod<'setCodeSalt'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['basic']);
  requireParams(req);

  const { code, salt } = req.params;
  requireString(req, req.params, 'code');
  requireString(req, req.params, 'salt');

  try {
    res.result = {
      code: ctx.nekoton.setCodeSalt(code, salt),
    };
    end();
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const encodeInternalInput: ProviderMethod<'encodeInternalInput'> = async (
  req,
  res,
  _next,
  end,
  ctx,
) => {
  requirePermissions(ctx, ['basic']);
  requireParams(req);

  requireFunctionCall(req, req, 'params');
  const { abi, method, params } = req.params;

  try {
    res.result = {
      boc: ctx.nekoton.encodeInternalInput(abi, method, params),
    };
    end();
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const decodeInput: ProviderMethod<'decodeInput'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['basic']);
  requireParams(req);

  const { body, abi, method, internal } = req.params;
  requireString(req, req.params, 'body');
  requireString(req, req.params, 'abi');
  requireMethodOrArray(req, req.params, 'method');
  requireBoolean(req, req.params, 'internal');

  try {
    res.result = ctx.nekoton.decodeInput(body, abi, method, internal) || null;
    end();
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const decodeEvent: ProviderMethod<'decodeEvent'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['basic']);
  requireParams(req);

  const { body, abi, event } = req.params;
  requireString(req, req.params, 'body');
  requireString(req, req.params, 'abi');
  requireMethodOrArray(req, req.params, 'event');

  try {
    res.result = ctx.nekoton.decodeEvent(body, abi, event) || null;
    end();
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const decodeOutput: ProviderMethod<'decodeOutput'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['basic']);
  requireParams(req);

  const { body, abi, method } = req.params;
  requireString(req, req.params, 'body');
  requireString(req, req.params, 'abi');
  requireMethodOrArray(req, req.params, 'method');

  try {
    res.result = ctx.nekoton.decodeOutput(body, abi, method) || null;
    end();
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const decodeTransaction: ProviderMethod<'decodeTransaction'> = async (
  req,
  res,
  _next,
  end,
  ctx,
) => {
  requirePermissions(ctx, ['basic']);
  requireParams(req);

  const { transaction, abi, method } = req.params;
  requireString(req, req.params, 'abi');
  requireMethodOrArray(req, req.params, 'method');

  try {
    res.result = ctx.nekoton.decodeTransaction(transaction, abi, method) || null;
    end();
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const decodeTransactionEvents: ProviderMethod<'decodeTransactionEvents'> = async (
  req,
  res,
  _next,
  end,
  ctx,
) => {
  requirePermissions(ctx, ['basic']);
  requireParams(req);

  const { transaction, abi } = req.params;
  requireString(req, req.params, 'abi');

  try {
    res.result = {
      events: ctx.nekoton.decodeTransactionEvents(transaction, abi),
    };
    end();
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const verifySignature: ProviderMethod<'verifySignature'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['basic']);
  requireParams(req);

  const { publicKey, dataHash, signature } = req.params;
  requireString(req, req.params, 'publicKey');
  requireString(req, req.params, 'dataHash');
  requireString(req, req.params, 'signature');

  try {
    res.result = {
      isValid: ctx.nekoton.verifySignature(publicKey, dataHash, signature),
    };
    end();
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const sendUnsignedExternalMessage: ProviderMethod<'sendUnsignedExternalMessage'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['basic']);
  requireParams(req);

  const { recipient, stateInit, payload, local } = req.params;
  requireString(req, req.params, 'recipient');
  requireOptionalString(req, req.params, 'stateInit');
  requireFunctionCall(req, req.params, 'payload');
  requireOptionalBoolean(req, req.params, 'local');

  const { subscriptionsController, clock } = ctx;

  let repackedRecipient: string;
  try {
    repackedRecipient = ctx.nekoton.repackAddress(recipient);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  let signedMessage: nt.SignedMessage;
  try {
    signedMessage = ctx.nekoton.createExternalMessageWithoutSignature(
      clock,
      repackedRecipient,
      payload.abi,
      payload.method,
      stateInit,
      payload.params,
      60,
    );
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  let transaction: nt.Transaction;
  if (local === true) {
    transaction = await subscriptionsController.sendMessageLocally(
      repackedRecipient,
      signedMessage,
    );
  } else {
    transaction = await subscriptionsController.sendMessage(
      repackedRecipient,
      signedMessage,
    );
  }

  let output: nt.TokensObject | undefined;
  try {
    const decoded = ctx.nekoton.decodeTransaction(transaction, payload.abi, payload.method);
    output = decoded?.output;
  } catch (_) { // eslint-disable-line no-empty
  }

  res.result = {
    transaction,
    output,
  };
  end();
};

const addAsset: ProviderMethod<'addAsset'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['accountInteraction']);
  requireParams(req);

  const { account, type, params } = req.params;
  requireString(req, req.params, 'account');
  requireString(req, req.params, 'type');
  requireAssetTypeParams(req, req.params, 'params', type);

  const { origin, permissionsController, approvalController, jrpcClient } = ctx;

  const allowedAccount = permissionsController.getPermissions(origin).accountInteraction;
  if (allowedAccount?.address !== account) {
    throw invalidRequest(req, 'Specified account is not allowed');
  }

  switch (type) {
    case 'tip3_token': {
      const { rootContract: rawRootContract } = params;
      let rootContract: string;
      try {
        rootContract = ctx.nekoton.repackAddress(rawRootContract);
      } catch (e: any) {
        throw invalidRequest(req, e.toString());
      }

      const { hasTokenWallet, details } = await jrpcClient.request('getTokenWalletInfo', { account, rootContract });

      if (hasTokenWallet) {
        res.result = { newAsset: false };
        return end();
      }

      await approvalController.addAndShowApprovalRequest({
        origin,
        type: 'addTip3Token',
        requestData: {
          account,
          details,
        },
      });

      await jrpcClient.request('updateTokenWallets', { account, rootContract });

      res.result = { newAsset: true };
      return end();
    }
    default:
      throw invalidRequest(req, 'Unknown asset type');
  }
};

const signData: ProviderMethod<'signData'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['accountInteraction']);
  requireParams(req);

  const { publicKey, data } = req.params;
  requireString(req, req.params, 'publicKey');
  requireString(req, req.params, 'data');

  const { origin, approvalController, permissionsController, jrpcClient } = ctx;
  const allowedAccount = permissionsController.getPermissions(origin).accountInteraction;
  if (allowedAccount?.publicKey !== publicKey) {
    throw invalidRequest(req, 'Specified signer is not allowed');
  }

  const approvalId = nanoid();
  const password = await approvalController.addAndShowApprovalRequest({
    origin,
    id: approvalId,
    type: 'signData',
    requestData: {
      publicKey,
      data,
    },
  });

  try {
    res.result = await jrpcClient.request('signData', { data, password });
    end();
  } catch (e: any) {
    throw invalidRequest(req, e.message ?? e.toString());
  } finally {
    approvalController.deleteApproval(approvalId);
  }
};

const signDataRaw: ProviderMethod<'signDataRaw'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['accountInteraction']);
  requireParams(req);

  const { publicKey, data } = req.params;
  requireString(req, req.params, 'publicKey');
  requireString(req, req.params, 'data');

  const { origin, approvalController, permissionsController, jrpcClient } = ctx;
  const allowedAccount = permissionsController.getPermissions(origin).accountInteraction;
  if (allowedAccount?.publicKey !== publicKey) {
    throw invalidRequest(req, 'Specified signer is not allowed');
  }

  const approvalId = nanoid();
  const password = await approvalController.addAndShowApprovalRequest({
    origin,
    id: approvalId,
    type: 'signData',
    requestData: {
      publicKey,
      data,
    },
  });

  try {
    res.result = await jrpcClient.request('signDataRaw', { data, password });
    end();
  } catch (e: any) {
    throw invalidRequest(req, e.message ?? e.toString());
  } finally {
    approvalController.deleteApproval(approvalId);
  }
};

const encryptData: ProviderMethod<'encryptData'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['accountInteraction']);
  requireParams(req);

  const { publicKey, recipientPublicKeys, algorithm, data } = req.params;
  requireString(req, req.params, 'publicKey');
  requireArray(req, req.params, 'recipientPublicKeys');
  requireString(req, req.params, 'algorithm');
  requireString(req, req.params, 'data');

  const { origin, approvalController, permissionsController, jrpcClient } = ctx;
  const allowedAccount = permissionsController.getPermissions(origin).accountInteraction;
  if (allowedAccount?.publicKey !== publicKey) {
    throw invalidRequest(req, 'Specified encryptor public key is not allowed');
  }

  const approvalId = nanoid();
  const password = await approvalController.addAndShowApprovalRequest({
    origin,
    id: approvalId,
    type: 'encryptData',
    requestData: {
      publicKey,
      data,
    },
  });

  try {
    res.result = {
      encryptedData: await jrpcClient.request('encryptData', {
        data,
        recipientPublicKeys,
        algorithm,
        password,
      }),
    };
    end();
  } catch (e: any) {
    throw invalidRequest(req, e.message ?? e.toString());
  } finally {
    approvalController.deleteApproval(approvalId);
  }
};

const decryptData: ProviderMethod<'decryptData'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['accountInteraction']);
  requireParams(req);

  const { encryptedData } = req.params;
  requireObject(req, req.params, 'encryptedData');
  requireString(req, encryptedData, 'algorithm');
  requireString(req, encryptedData, 'sourcePublicKey');
  requireString(req, encryptedData, 'recipientPublicKey');
  requireString(req, encryptedData, 'data');
  requireString(req, encryptedData, 'nonce');

  const { origin, approvalController, permissionsController, jrpcClient } = ctx;
  const allowedAccount = permissionsController.getPermissions(origin).accountInteraction;
  if (allowedAccount?.publicKey !== encryptedData.recipientPublicKey) {
    throw invalidRequest(req, 'Specified recipient public key is not allowed');
  }

  try {
    await jrpcClient.request('checkPublicKey', { publicKey: encryptedData.sourcePublicKey });
  } catch (e: any) {
    throw invalidRequest(req, e.message ?? e.toString());
  }

  const approvalId = nanoid();
  const password = await approvalController.addAndShowApprovalRequest({
    origin,
    id: approvalId,
    type: 'decryptData',
    requestData: {
      publicKey: allowedAccount.publicKey,
      sourcePublicKey: encryptedData.sourcePublicKey,
    },
  });

  try {
    res.result = {
      data: await jrpcClient.request('decryptData', { encryptedData, password }),
    };
    end();
  } catch (e: any) {
    throw invalidRequest(req, e.message ?? e.toString());
  } finally {
    approvalController.deleteApproval(approvalId);
  }
};

const estimateFees: ProviderMethod<'estimateFees'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['accountInteraction']);
  requireParams(req);

  const { sender, recipient, amount, payload } = req.params;
  requireString(req, req.params, 'sender');
  requireString(req, req.params, 'recipient');
  requireString(req, req.params, 'amount');
  requireOptional(req, req.params, 'payload', requireFunctionCall);

  const { origin, clock, permissionsController, connectionController, subscriptionsController } = ctx;

  const allowedAccount = permissionsController.getPermissions(origin).accountInteraction;
  if (allowedAccount?.address !== sender) {
    throw invalidRequest(req, 'Specified sender is not allowed');
  }

  const selectedAddress = allowedAccount.address;
  let repackedRecipient: string;
  try {
    repackedRecipient = ctx.nekoton.repackAddress(recipient);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  let body: string = '';
  if (payload != null) {
    try {
      body = ctx.nekoton.encodeInternalInput(payload.abi, payload.method, payload.params);
    } catch (e: any) {
      throw invalidRequest(req, e.toString());
    }
  }

  const contractState = await connectionController.use(
    ({ data: { transport } }) => transport.getFullContractState(selectedAddress),
  );

  if (contractState == null) {
    throw invalidRequest(req, `Failed to get contract state for ${selectedAddress}`);
  }

  let unsignedMessage: nt.UnsignedMessage | undefined;
  try {
    unsignedMessage = ctx.nekoton.walletPrepareTransfer(
      clock,
      contractState.boc,
      allowedAccount.contractType,
      allowedAccount.publicKey,
      [{
        body,
        amount,
        destination: repackedRecipient,
        bounce: false,
        flags: 3,
      }],
      60,
    );
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  if (!unsignedMessage) {
    throw invalidRequest(req, 'Contract must be deployed first');
  }

  let fees: string;
  try {
    const signedMessage = unsignedMessage.signFake();
    const transaction = await subscriptionsController.sendMessageLocally(selectedAddress, signedMessage);

    fees = transaction.totalFees;
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  } finally {
    unsignedMessage.free();
  }

  res.result = {
    fees,
  };
  end();
};

const sendMessage: ProviderMethod<'sendMessage'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['accountInteraction']);
  requireParams(req);

  const { sender, recipient, amount, bounce, payload } = req.params;
  requireString(req, req.params, 'sender');
  requireString(req, req.params, 'recipient');
  requireString(req, req.params, 'amount');
  requireBoolean(req, req.params, 'bounce');
  requireOptional(req, req.params, 'payload', requireFunctionCall);

  const {
    origin,
    nekoton,
    jrpcClient,
    permissionsController,
    approvalController,
    subscriptionsController,
  } = ctx;

  const allowedAccount = permissionsController.getPermissions(origin).accountInteraction;
  if (allowedAccount?.address !== sender) {
    throw invalidRequest(req, 'Specified sender is not allowed');
  }

  const selectedAddress = allowedAccount.address;
  let repackedRecipient: string;
  try {
    repackedRecipient = nekoton.repackAddress(recipient);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  let body: string = '';
  let knownPayload: KnownPayload | undefined;
  if (payload != null) {
    try {
      body = nekoton.encodeInternalInput(payload.abi, payload.method, payload.params);
      knownPayload = await ctx.jrpcClient.request('parseKnownPayload', { payload: body });
    } catch (e: any) {
      throw invalidRequest(req, e.message ?? e.toString());
    }
  }

  const approvalId = nanoid();
  const password = await approvalController.addAndShowApprovalRequest({
    id: approvalId,
    origin,
    type: 'sendMessage',
    requestData: {
      sender: selectedAddress,
      recipient: repackedRecipient,
      amount,
      bounce,
      payload,
      knownPayload,
    },
  });

  let signedMessage: nt.SignedMessage | undefined;
  try {
    signedMessage = await jrpcClient.request('signMessage', {
      amount,
      bounce,
      body,
      password,
      address: selectedAddress,
      destination: repackedRecipient,
      timeout: 60,
    }) as nt.SignedMessage;
  } catch (e: any) {
    throw invalidRequest(req, e.message ?? e.toString());
  } finally {
    approvalController.deleteApproval(approvalId);
  }

  const transaction: nt.Transaction = await subscriptionsController.sendMessage(selectedAddress, signedMessage);

  if (transaction.resultCode !== 0) {
    throw invalidRequest(req, 'Action phase failed');
  }

  res.result = {
    transaction,
  };
  end();
};

const sendExternalMessage: ProviderMethod<'sendExternalMessage'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['accountInteraction']);
  requireParams(req);

  const { publicKey, recipient, stateInit, payload, local } = req.params;
  requireString(req, req.params, 'publicKey');
  requireString(req, req.params, 'recipient');
  requireOptionalString(req, req.params, 'stateInit');
  requireFunctionCall(req, req.params, 'payload');
  requireOptionalBoolean(req, req.params, 'local');

  const {
    origin,
    clock,
    nekoton,
    jrpcClient,
    permissionsController,
    approvalController,
    subscriptionsController,
  } = ctx;

  const allowedAccount = permissionsController.getPermissions(origin).accountInteraction;
  if (allowedAccount?.publicKey !== publicKey) {
    throw invalidRequest(req, 'Specified signer is not allowed');
  }

  const selectedPublicKey = allowedAccount.publicKey;
  let repackedRecipient: string;
  try {
    repackedRecipient = nekoton.repackAddress(recipient);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  let unsignedMessage: nt.UnsignedMessage;
  try {
    unsignedMessage = nekoton.createExternalMessage(
      clock,
      repackedRecipient,
      payload.abi,
      payload.method,
      stateInit,
      payload.params,
      selectedPublicKey,
      60,
    );
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  const approvalId = nanoid();
  const password = await approvalController.addAndShowApprovalRequest({
    origin,
    id: approvalId,
    type: 'callContractMethod',
    requestData: {
      publicKey: selectedPublicKey,
      recipient: repackedRecipient,
      payload,
    },
  });

  let signedMessage: nt.SignedMessage;
  try {
    signedMessage = await jrpcClient.request('signExternalMessage', {
      payload,
      stateInit,
      password,
      destination: repackedRecipient,
      timeout: 60,
    });
  } catch (e: any) {
    throw invalidRequest(req, e.message ?? e.toString());
  } finally {
    unsignedMessage.free();
    approvalController.deleteApproval(approvalId);
  }

  let transaction: nt.Transaction;
  if (local === true) {
    transaction = await subscriptionsController.sendMessageLocally(repackedRecipient, signedMessage);
  } else {
    transaction = await subscriptionsController.sendMessage(repackedRecipient, signedMessage);
  }

  let output: nt.TokensObject | undefined;
  try {
    const decoded = ctx.nekoton.decodeTransaction(transaction, payload.abi, payload.method);
    output = decoded?.output;
  } catch (_) { // eslint-disable-line no-empty
  }

  res.result = {
    transaction,
    output,
  };
  end();
};

const getCodeSalt: ProviderMethod<'getCodeSalt'> = async (req, res, _next, end, ctx) => {
  requirePermissions(ctx, ['basic']);
  requireParams(req);

  const { nekoton } = ctx;
  const { code } = req.params;
  requireString(req, req.params, 'code');

  try {
    res.result = {
      salt: nekoton.getCodeSalt(code),
    };
    end();
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const providerRequests: Partial<{ [K in keyof RawProviderApi]: ProviderMethod<K> }> = {
  requestPermissions,
  changeAccount,
  disconnect,
  subscribe,
  unsubscribe,
  unsubscribeAll,
  getProviderState,
  getFullContractState,
  getAccountsByCodeHash,
  getTransactions,
  getTransaction,
  runLocal,
  getExpectedAddress,
  getBocHash,
  packIntoCell,
  unpackFromCell,
  extractPublicKey,
  codeToTvc,
  mergeTvc,
  splitTvc,
  setCodeSalt,
  encodeInternalInput,
  decodeInput,
  decodeEvent,
  decodeOutput,
  decodeTransaction,
  decodeTransactionEvents,
  verifySignature,
  sendUnsignedExternalMessage,
  addAsset,
  signData,
  signDataRaw,
  encryptData,
  decryptData,
  estimateFees,
  sendMessage,
  sendExternalMessage,
  getCodeSalt,
};

export const createStandaloneProviderMiddleware = (
  options: CreateProviderMiddlewareOptions,
): JsonRpcMiddleware<unknown, unknown> => (req, res, next, end) => {
  if (!(providerRequests as any)[req.method]) {
    end(
      new NekotonRpcError(
        RpcErrorCode.METHOD_NOT_FOUND,
        `provider method '${req.method}' not found`,
      ),
    );
  } else {
    const method = (providerRequests as any)[req.method] as ProviderMethod<any>;
    method(req, res, next, end, options)
      .catch(end);
  }
};
