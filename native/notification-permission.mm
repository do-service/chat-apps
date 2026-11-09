#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <node_api.h>
#include <atomic>
#include <memory>
#include <string>

namespace {
struct Operation {
  napi_threadsafe_function callback = nullptr;
  std::atomic<bool> completed{false};
};
struct Completion {
  napi_deferred deferred;
  std::shared_ptr<Operation> operation;
  bool cleaningUp = false;
};

void Cleanup(void* data) {
  auto* completion = static_cast<Completion*>(data);
  completion->cleaningUp = true;
  if (!completion->operation->completed.exchange(true)) {
    napi_release_threadsafe_function(completion->operation->callback, napi_tsfn_abort);
  }
}

void Finalize(napi_env env, void* data, void*) {
  std::unique_ptr<Completion> completion(static_cast<Completion*>(data));
  if (env && !completion->cleaningUp) napi_remove_env_cleanup_hook(env, Cleanup, completion.get());
}

const char* Permission(UNNotificationSettings* settings) {
  if (!settings) return "unknown";
  switch (settings.authorizationStatus) {
    case UNAuthorizationStatusNotDetermined: return "not-determined";
    case UNAuthorizationStatusDenied: return "denied";
    case UNAuthorizationStatusAuthorized: return "granted";
    // Provisional/ephemeral authorization is not a promise of alert permission.
    default: return "unknown";
  }
}

void Resolve(napi_env env, napi_value, void* context, void* data) {
  std::unique_ptr<std::string> status(static_cast<std::string*>(data));
  if (!env || !context || !status) return;  // Environment shutdown may drain queued calls.
  napi_value result;
  if (napi_create_string_utf8(env, status->c_str(), NAPI_AUTO_LENGTH, &result) == napi_ok) {
    napi_resolve_deferred(env, static_cast<Completion*>(context)->deferred, result);
  }
}

void Finish(const std::shared_ptr<Operation>& operation, const char* status) {
  if (operation->completed.exchange(true)) return;
  auto result = std::make_unique<std::string>(status);
  if (napi_call_threadsafe_function(operation->callback, result.get(), napi_tsfn_nonblocking) == napi_ok) result.release();
  napi_release_threadsafe_function(operation->callback, napi_tsfn_release);
}

napi_value Start(napi_env env, bool request) {
  napi_value promise, name;
  auto completion = std::make_unique<Completion>();
  if (napi_create_promise(env, &completion->deferred, &promise) != napi_ok) return nullptr;
  if (napi_create_string_utf8(env, "notification-permission", NAPI_AUTO_LENGTH, &name) != napi_ok) return nullptr;
  auto operation = std::make_shared<Operation>();
  completion->operation = operation;
  if (napi_create_threadsafe_function(env, nullptr, nullptr, name, 1, 1,
      completion.get(), Finalize, completion.get(), Resolve, &operation->callback) != napi_ok) return nullptr;
  if (napi_add_env_cleanup_hook(env, Cleanup, completion.get()) != napi_ok) {
    operation->completed.store(true);
    napi_release_threadsafe_function(operation->callback, napi_tsfn_abort);
    completion.release();  // The TSFN finalizer now owns the context.
    return nullptr;
  }
  completion.release();
  // TSFN is the sole bridge back to Node. No N-API calls run on an Apple completion queue.
  // Shared ownership keeps a late OS callback safe after timeout or JS environment teardown.
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (request ? 30 : 5) * NSEC_PER_SEC),
      dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{ Finish(operation, "unknown"); });
  // Electron main JS runs on the Cocoa main thread. Invoke the OS API before
  // returning to JS so navigation/logout cannot slip between its guard and prompt.
  // Workers are deliberately unsupported rather than dispatching a stale request.
  if (![NSThread isMainThread]) { Finish(operation, "unknown"); return promise; }
  @autoreleasepool {
      if (operation->completed.load()) return promise;
      @try {
        UNUserNotificationCenter* center = [UNUserNotificationCenter currentNotificationCenter];
        if (!request) {
          [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings* settings) {
            Finish(operation, Permission(settings));
          }];
        } else {
          [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge)
              completionHandler:^(BOOL, NSError* error) {
            if (error) { Finish(operation, "unknown"); return; }
            [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings* settings) {
              Finish(operation, Permission(settings));
            }];
          }];
        }
      } @catch (NSException*) { Finish(operation, "unknown"); }
  }
  return promise;
}

napi_value GetPermission(napi_env env, napi_callback_info) { return Start(env, false); }
napi_value RequestPermission(napi_env env, napi_callback_info) { return Start(env, true); }

napi_value Initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    {"getPermission", nullptr, GetPermission, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"requestPermission", nullptr, RequestPermission, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(env, exports, 2, properties) != napi_ok) return nullptr;
  return exports;
}
}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
