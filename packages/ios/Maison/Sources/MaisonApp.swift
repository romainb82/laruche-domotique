import SwiftUI
import DomoKit

@main
struct MaisonApp: App {
    @State private var store = HouseStore()

    var body: some Scene {
        WindowGroup {
            HouseView()
                .environment(store)
                .tint(Theme.glow)
                .task {
                    // On cherche la maison sur le réseau avant tout : personne
                    // ne devrait avoir à saisir une adresse IP.
                    await store.demarrer()
                }
        }
    }
}
