import Foundation
import Capacitor
import UIKit

// Minimal custom plugin exposing UIApplication.canOpenURL to JS, since none
// of our installed Capacitor plugins provide this and iOS requires a native
// check (canOpenURL is blocked for schemes not declared in
// LSApplicationQueriesSchemes -- see Info.plist). Only uses CAPPluginCall
// APIs confirmed never gated by capacitor-swift-pm's upstream
// "$NonescapableTypes" packaging bug (see the patches/ directory for the
// full explanation), so this custom plugin needs no patch-package workaround.
@objc(UrlCheckerPlugin)
public class UrlCheckerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "UrlCheckerPlugin"
    public let jsName = "UrlChecker"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "canOpenUrl", returnType: CAPPluginReturnPromise)
    ]

    @objc func canOpenUrl(_ call: CAPPluginCall) {
        let urlString = call.getString("url", "")
        guard !urlString.isEmpty, let url = URL(string: urlString) else {
            call.resolve(["value": false])
            return
        }
        DispatchQueue.main.async {
            call.resolve(["value": UIApplication.shared.canOpenURL(url)])
        }
    }
}
