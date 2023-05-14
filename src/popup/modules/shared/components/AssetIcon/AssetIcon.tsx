import classNames from 'classnames'
import { observer } from 'mobx-react-lite'

import { AssetType } from '@app/shared'

import { useResolve } from '../../hooks'
import { TokensStore } from '../../store'
import { UserAvatar } from '../UserAvatar'
import { EverAssetIcon } from './EverAssetIcon'

import './AssetIcon.scss'

interface Props {
    type: AssetType;
    address: string;
    className?: string;
    old?: boolean;
}

export const AssetIcon = observer(({ type, address, old, className }: Props): JSX.Element => {
    const { tokens } = useResolve(TokensStore)

    if (type === 'ever_wallet') {
        return <EverAssetIcon className={classNames('asset-icon', className)} />
    }

    const logoURI = tokens[address]?.logoURI

    return (
        <div className={classNames('asset-icon _token', className)}>
            {logoURI ? <img src={logoURI} alt="" /> : <UserAvatar address={address} />}
            {old && <div className="outdated-asset-badge" />}
        </div>
    )
})
