import SwiftUI
import DomoKit

@main
struct MaisonApp: App {
    @State private var store = HouseStore()

    var body: some Scene {
        WindowGroup {
            Group {
                // La porte d'entrée s'affiche SEULE, sans la maison derrière :
                // on ne décrit pas les pièces à qui n'est pas encore entré.
                // Tant que le serveur n'a pas dit si le jeton tient, on
                // n'affiche ni l'une ni l'autre : une porte qui clignote
                // avant de s'ouvrir est pire qu'une demi-seconde de vide.
                if store.sessionInconnue {
                    Theme.ground.ignoresSafeArea()
                } else if store.authentifie {
                    HouseView()
                } else {
                    LoginView()
                }
            }
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
