var patchController = require('./patches/controllerPatch')
var patchCompile = require('./patches/compilePatch')
var patchRootScope = require('./patches/rootScopePatch')
var patchDirectives = require('./patches/directivesPatch')
var patchExceptionHandler = require('./patches/exceptionHandlerPatch')
var patchInteractions = require('./patches/interactionsPatch')

var utils = require('opbeat-js-core').utils

function NgOpbeatProvider (logger, configService, exceptionHandler) {
  this.config = function config (properties) {
    if (properties) {
      configService.setConfig(properties)
    }
  }

  this.version = configService.get('VERSION')

  this.install = function install () {
    logger.warn('$opbeatProvider.install is deprecated!')
  }

  this.$get = [
    function () {
      return {
        getConfig: function config () {
          return configService
        },
        captureException: function captureException (exception, options) {
          if (!(exception instanceof Error)) {
            logger.warn("Can't capture exception. Passed exception needs to be an instanceof Error")
            return
          }

          // TraceKit.report will re-raise any exception passed to it,
          // which means you have to wrap it in try/catch. Instead, we
          // can wrap it here and only re-raise if TraceKit.report
          // raises an exception different from the one we asked to
          // report on.

          exceptionHandler.processError(exception, options)
        },

        setUserContext: function setUser (user) {
          configService.set('context.user', user)
        },

        setExtraContext: function setExtraContext (data) {
          configService.set('context.extra', data)
        }
      }
    }
  ]
}

function patchAll ($provide, transactionService) {
  patchExceptionHandler($provide)
  patchController($provide, transactionService)
  patchCompile($provide, transactionService)
  patchRootScope($provide, transactionService)
  patchDirectives($provide, transactionService)
  patchInteractions($provide, transactionService)
}

function publishExternalApi (spec) {
  var opbeat = window.opbeat || (window.opbeat = {})
  utils.extend(opbeat, spec)
}

function noop () {}

function registerOpbeatModule (services) {
  var transactionService = services.transactionService
  var logger = services.logger
  var configService = services.configService
  var exceptionHandler = services.exceptionHandler
  var angularInitializer = services.angularInitializer

  var routeChanged = false
  var hardNavigation = true

  function moduleRun ($rootScope, $injector) {
    configService.set('isInstalled', true)
    configService.set('opbeatAgentName', 'opbeat-angular')
    configService.set('platform.framework', 'angular/' + window.angular.version.full)

    var platform = getPlatform()
    if (platform) {
      configService.set('platform.platform', platform)
    }

    logger.debug('Agent:', configService.getAgentName())

    function startRouteChange (name) {
      routeChanged = true
      if (!configService.get('performance.enable')) {
        logger.debug('Performance monitoring is disable')
        return
      }
      logger.debug('Route change started')
      var transactionName = name
      if (transactionName === '' || typeof transactionName === 'undefined') {
        transactionName = '/'
      }

      var tr = transactionService.startTransaction(transactionName, 'route-change')
      if (tr && hardNavigation) {
        hardNavigation = false
        tr.isHardNavigation = true
      }
    }

    function onRouteChangeStart (event, current) {
      var transactionName
      if (current && current.$$route) { // ngRoute
        // ignoring redirects since we will get another event
        if (typeof current.$$route.redirectTo !== 'undefined') {
          return
        }
        transactionName = current.$$route.originalPath
      } else if (current && current.name) { // UI Router
        transactionName = current.name
      }
      startRouteChange(transactionName)
    }

    // ui-router 1
    if ($injector.has('$transitions')) {
      var $transitions = $injector.get('$transitions')

      $transitions.onStart({ }, function uiRouterOnStart (trans) {
        var to = trans.to()
        startRouteChange(to.name)
      })
    } else {

      // ng-router
      $rootScope.$on('$routeChangeStart', onRouteChangeStart)

      // ui-router
      $rootScope.$on('$stateChangeStart', onRouteChangeStart)
    }
  }

  function moduleConfig ($provide) {
    patchAll($provide, transactionService)
  }

  function getPlatform () {
    var isCordovaApp = (typeof window.cordova !== 'undefined')
    if (isCordovaApp) {
      return 'cordova'
    } else {
      return 'browser'
    }
  }

  publishExternalApi({
    'setInitialPageLoadName': function setInitialPageLoadName (name) {
      transactionService.initialPageLoadName = name
    }
  })

  if (window.angular && typeof window.angular.module === 'function') {
    if (!configService.isPlatformSupported()) {
      window.angular.module('ngOpbeat', [])
        .provider('$opbeat', new NgOpbeatProvider(logger, configService, exceptionHandler))
        .config(['$provide', noop])
        .run(['$rootScope', noop])
    } else {
      window.angular.module('ngOpbeat', [])
        .provider('$opbeat', new NgOpbeatProvider(logger, configService, exceptionHandler))
        .config(['$provide', moduleConfig])
        .run(['$rootScope', '$injector', moduleRun])

      angularInitializer.beforeBootstrap = function beforeBootstrap () {
        transactionService.metrics['appBeforeBootstrap'] = performance.now()
      }
      angularInitializer.afterBootstrap = function afterBootstrap () {
        transactionService.metrics['appAfterBootstrap'] = performance.now()
        if (!routeChanged) {
          transactionService.sendPageLoadMetrics()
        }
      }
    }
    window.angular.module('opbeat-angular', ['ngOpbeat'])
    return true
  }
}

module.exports = registerOpbeatModule
