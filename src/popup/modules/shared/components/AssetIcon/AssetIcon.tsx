import classNames from 'classnames'
import { observer } from 'mobx-react-lite'
import React from 'react'

import { AssetType } from '@app/shared'

import { useResolve } from '../../hooks'
import { TokensStore } from '../../store'
import { UserAvatar } from '../UserAvatar'
import { TonAssetIcon } from './TonAssetIcon'

import './AssetIcon.scss'

interface Props {
    type: AssetType;
    address: string;
    className?: string;
    old?: boolean;
}

export const AssetIcon = observer(({ type, address, old, className }: Props): JSX.Element => {
    const { meta } = useResolve(TokensStore)

    if (type === 'ton_wallet') {
        return <TonAssetIcon className={className} />
    }

    const logoURI = meta[address]?.logoURI

    return (
        <div className={classNames('asset-icon', className)}>
            {logoURI ? <img src={logoURI} alt="" /> : <UserAvatar address={address} />}
            {old && <div className="outdated-asset-badge" />}
        </div>
    )
})
