// HolyMoly netværksfilter – systemudvidelsens indgang.
import Foundation
import NetworkExtension

autoreleasepool {
    NEProvider.startSystemExtensionMode()
}
dispatchMain()
