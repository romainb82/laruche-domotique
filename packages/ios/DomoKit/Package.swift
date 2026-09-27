// swift-tools-version: 6.0
import PackageDescription

/// Le socle partagé entre l'app iOS et tout autre client Apple.
///
/// Il ne contient AUCUNE interface : uniquement le vocabulaire du domaine, le
/// client réseau et l'état vivant. C'est le miroir Swift de `@domo/shared`.
let package = Package(
    name: "DomoKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "DomoKit", targets: ["DomoKit"]),
    ],
    targets: [
        .target(name: "DomoKit"),
        .testTarget(name: "DomoKitTests", dependencies: ["DomoKit"]),
    ]
)
