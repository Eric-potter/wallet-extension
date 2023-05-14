import type * as nt from '@broxus/ever-wallet-wasm'
import { makeAutoObservable, runInAction } from 'mobx'
import { injectable } from 'tsyringe'

import { PendingApproval } from '@app/models'
import { AccountabilityStore, LocalizationStore, RpcStore, Utils } from '@app/popup/modules/shared'
import { ignoreCheckPassword, parseError, prepareKey } from '@app/popup/utils'
import { LedgerUtils } from '@app/popup/modules/ledger'

import { ApprovalStore } from '../../store'

@injectable()
export class ApproveContractInteractionViewModel {

    public passwordModalVisible = false

    public loading = false

    public error = ''

    public ledgerConnect = false

    constructor(
        public ledger: LedgerUtils,
        private rpcStore: RpcStore,
        private approvalStore: ApprovalStore,
        private accountability: AccountabilityStore,
        private localization: LocalizationStore,
        private utils: Utils,
    ) {
        makeAutoObservable(this, undefined, { autoBind: true })

        utils.when(() => this.keyEntry?.signerName === 'ledger_key', async () => {
            const connected = await ledger.checkLedger()
            if (!connected) {
                runInAction(() => {
                    this.ledgerConnect = true
                })
            }
        })
    }

    public get approval(): PendingApproval<'callContractMethod'> {
        return this.approvalStore.approval as PendingApproval<'callContractMethod'>
    }

    public get networkName(): string {
        return this.rpcStore.state.selectedConnection.name
    }

    public get keyEntry(): nt.KeyStoreEntry {
        return this.accountability.storedKeys[this.approval.requestData.publicKey]
    }

    public get masterKeysNames(): Record<string, string> {
        return this.accountability.masterKeysNames
    }

    public get account(): nt.AssetsList | undefined {
        return Object.values(this.accountability.accountEntries).find(
            account => account.tonWallet.publicKey === this.approval.requestData.publicKey,
        )
    }

    public openPasswordModal(): void {
        this.passwordModalVisible = true
    }

    public closePasswordModal(): void {
        this.passwordModalVisible = false
    }

    public async onReject(): Promise<void> {
        this.loading = true
        await this.approvalStore.rejectPendingApproval()
    }

    public async onSubmit(password?: string, cache?: boolean): Promise<void> {
        if (this.loading) return

        if (!this.keyEntry) {
            this.error = this.localization.intl.formatMessage({ id: 'ERROR_KEY_ENTRY_NOT_FOUND' })
            return
        }

        this.loading = true

        try {
            const { keyEntry, account } = this
            const wallet = account!.tonWallet.contractType
            const keyPassword = prepareKey({ keyEntry, password, cache, wallet })
            const isValid = ignoreCheckPassword(keyPassword) || await this.rpcStore.rpc.checkPassword(keyPassword)

            if (isValid) {
                await this.approvalStore.resolvePendingApproval(keyPassword, true)
            }
            else {
                runInAction(() => {
                    this.error = this.localization.intl.formatMessage({ id: 'ERROR_INVALID_PASSWORD' })
                })
            }
        }
        catch (e: any) {
            runInAction(() => {
                this.error = parseError(e)
            })
        }
        finally {
            runInAction(() => {
                this.loading = false
            })
        }
    }

    public handleLedgerConnected(): void {
        this.ledgerConnect = false
    }

    public async handleLedgerFailed(): Promise<void> {
        await this.approvalStore.rejectPendingApproval()
    }

}
