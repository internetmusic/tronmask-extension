import copyToClipboard from 'copy-to-clipboard'
import log from 'loglevel'
import { clone } from 'lodash'
import React from 'react'
import { render } from 'react-dom'
import { getEnvironmentType } from '../app/scripts/lib/util'
import { ALERT_TYPES } from '../app/scripts/controllers/alert'
import { SENTRY_STATE } from '../app/scripts/lib/setupSentry'
import { ENVIRONMENT_TYPE_POPUP } from '../app/scripts/lib/enums'
import Root from './app/pages'
import * as actions from './app/store/actions'
import configureStore from './app/store/store'
import txHelper from './lib/tx-helper'
import { fetchLocale, loadRelativeTimeFormatLocaleData } from './app/helpers/utils/i18n-helper'
import switchDirection from './app/helpers/utils/switch-direction'
import { getPermittedAccountsForCurrentTab, getSelectedAddress } from './app/selectors'
import { ALERT_STATE } from './app/ducks/alerts/unconnected-account'
import {
  getUnconnectedAccountAlertEnabledness,
  getUnconnectedAccountAlertShown,
} from './app/ducks/tronmask/tronmask'

log.setLevel(global.TRONMASK_DEBUG ? 'debug' : 'warn')

export default function launchTronmaskUi (opts, cb) {
  const { backgroundConnection } = opts
  actions._setBackgroundConnection(backgroundConnection)
  // check if we are unlocked first
  backgroundConnection.getState(function (err, tronmaskState) {
    if (err) {
      cb(err)
      return
    }
    startApp(tronmaskState, backgroundConnection, opts)
      .then((store) => {
        setupDebuggingHelpers(store)
        cb(null, store)
      })
  })
}

async function startApp (tronmaskState, backgroundConnection, opts) {
  // parse opts
  if (!tronmaskState.featureFlags) {
    tronmaskState.featureFlags = {}
  }

  const currentLocaleMessages = tronmaskState.currentLocale
    ? await fetchLocale(tronmaskState.currentLocale)
    : {}
  const enLocaleMessages = await fetchLocale('en')

  await loadRelativeTimeFormatLocaleData('en')
  if (tronmaskState.currentLocale) {
    await loadRelativeTimeFormatLocaleData(tronmaskState.currentLocale)
  }

  if (tronmaskState.textDirection === 'rtl') {
    await switchDirection('rtl')
  }

  const draftInitialState = {
    activeTab: opts.activeTab,

    // tronmaskState represents the cross-tab state
    tronmask: tronmaskState,

    // appState represents the current tab's popup state
    appState: {},

    localeMessages: {
      current: currentLocaleMessages,
      en: enLocaleMessages,
    },
  }

  if (getEnvironmentType() === ENVIRONMENT_TYPE_POPUP) {
    const { origin } = draftInitialState.activeTab
    const permittedAccountsForCurrentTab = getPermittedAccountsForCurrentTab(draftInitialState)
    const selectedAddress = getSelectedAddress(draftInitialState)
    const unconnectedAccountAlertShownOrigins = getUnconnectedAccountAlertShown(draftInitialState)
    const unconnectedAccountAlertIsEnabled = getUnconnectedAccountAlertEnabledness(draftInitialState)

    if (
      origin &&
      unconnectedAccountAlertIsEnabled &&
      !unconnectedAccountAlertShownOrigins[origin] &&
      permittedAccountsForCurrentTab.length > 0 &&
      !permittedAccountsForCurrentTab.includes(selectedAddress)
    ) {
      draftInitialState[ALERT_TYPES.unconnectedAccount] = { state: ALERT_STATE.OPEN }
      actions.setUnconnectedAccountAlertShown(origin)
    }
  }

  const store = configureStore(draftInitialState)

  // if unconfirmed txs, start on txConf page
  const unapprovedTxsAll = txHelper(
    tronmaskState.unapprovedTxs,
    tronmaskState.unapprovedMsgs,
    tronmaskState.unapprovedPersonalMsgs,
    tronmaskState.unapprovedDecryptMsgs,
    tronmaskState.unapprovedEncryptionPublicKeyMsgs,
    tronmaskState.unapprovedTypedMessages,
    tronmaskState.network,
  )
  const numberOfUnapprivedTx = unapprovedTxsAll.length
  if (numberOfUnapprivedTx > 0) {
    store.dispatch(actions.showConfTxPage({
      id: unapprovedTxsAll[0].id,
    }))
  }

  backgroundConnection.on('update', function (state) {
    store.dispatch(actions.updateTronmaskState(state))
  })

  // global tronmask api - used by tooling
  global.tronmask = {
    updateCurrentLocale: (code) => {
      store.dispatch(actions.updateCurrentLocale(code))
    },
    setProviderType: (type) => {
      store.dispatch(actions.setProviderType(type))
    },
    setFeatureFlag: (key, value) => {
      store.dispatch(actions.setFeatureFlag(key, value))
    },
  }

  // start app
  render(
    <Root
      store={store}
    />,
    opts.container,
  )

  return store
}

/**
 * Return a "masked" copy of the given object.
 *
 * The returned object includes only the properties present in the mask. The
 * mask is an object that mirrors the structure of the given object, except
 * the only values are `true` or a sub-mask. `true` implies the property
 * should be included, and a sub-mask implies the property should be further
 * masked according to that sub-mask.
 *
 * @param {Object} object - The object to mask
 * @param {Object<Object|boolean>} mask - The mask to apply to the object
 */
function maskObject (object, mask) {
  return Object.keys(object)
    .reduce(
      (state, key) => {
        if (mask[key] === true) {
          state[key] = object[key]
        } else if (mask[key]) {
          state[key] = maskObject(object[key], mask[key])
        }
        return state
      },
      {},
    )
}

function setupDebuggingHelpers (store) {
  window.getCleanAppState = function () {
    const state = clone(store.getState())
    state.version = global.platform.getVersion()
    state.browser = window.navigator.userAgent
    return state
  }
  window.getSentryState = function () {
    const fullState = store.getState()
    const debugState = maskObject(fullState, SENTRY_STATE)
    return {
      browser: window.navigator.userAgent,
      store: debugState,
      version: global.platform.getVersion(),
    }
  }
}

window.logStateString = function (cb) {
  const state = window.getCleanAppState()
  global.platform.getPlatformInfo((err, platform) => {
    if (err) {
      cb(err)
      return
    }
    state.platform = platform
    const stateString = JSON.stringify(state, null, 2)
    cb(null, stateString)
  })
}

window.logState = function (toClipboard) {
  return window.logStateString((err, result) => {
    if (err) {
      console.error(err.message)
    } else if (toClipboard) {
      copyToClipboard(result)
      console.log('State log copied')
    } else {
      console.log(result)
    }
  })
}
