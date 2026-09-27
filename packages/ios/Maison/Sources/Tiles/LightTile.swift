import SwiftUI
import DomoKit

/// Un éclairage.
///
/// La tuile EST le contrôle : on la touche pour allumer, on glisse dessus pour
/// régler. Et elle se remplit de lumière à hauteur de ce qu'elle éclaire — la
/// surface allumée est l'information, avant même le pourcentage.
struct LightTile: View {
    let device: Device
    @Environment(HouseStore.self) private var store
    @State private var apercu: Double?
    /// La hauteur suit le texte : figée, elle rognerait le contenu agrandi.
    @ScaledMetric(relativeTo: .body) private var hauteur: CGFloat = 122

    private var etat: DeviceState? { store.state(device.id) }
    private var infos: EtatTuile { EtatTuile(etat: etat) }
    private var allume: Bool { etat?.isOn ?? false }
    private var variable: Bool { etat?.level != nil }
    private var niveau: Double { allume ? (etat?.level ?? 100) : 0 }
    private var remplissage: Double { apercu ?? niveau }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottomLeading) {
                // La lumière monte à hauteur de l'intensité.
                LinearGradient(colors: [Theme.glow, Theme.glow.opacity(0.7)],
                               startPoint: .bottom, endPoint: .top)
                    .frame(height: geo.size.height * remplissage / 100)
                    .frame(maxHeight: .infinity, alignment: .bottom)
                    .animation(.spring(duration: 0.4), value: remplissage)

                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .top) {
                        Image(systemName: allume ? "lightbulb.fill" : "lightbulb")
                            .police(17)
                            .frame(width: 34, height: 34)
                            .background(allume ? Theme.ink.opacity(0.14) : Theme.ink.opacity(0.06))
                            .foregroundStyle(allume ? Theme.ink : Theme.faint)
                            .clipShape(Circle())
                            .opacity(infos.pending ? 0.5 : 1)
                        Spacer()
                        // Un « 0 % » sur une lampe éteinte n'apprend rien :
                        // l'état est déjà écrit en toutes lettres en dessous.
                        if variable, !infos.injoignable, remplissage > 0 {
                            Text("\(Int(remplissage))%")
                                .police(15, .semibold, .monospaced)
                                .foregroundStyle(Theme.ink)
                        }
                    }
                    Spacer()
                    Text(device.label)
                        .police(13, .semibold)
                        .lineLimit(1)
                        .foregroundStyle(allume ? Theme.ink : Theme.soft)
                    Text(infos.mention.isEmpty ? (allume ? "allumé" : "éteint") : infos.mention)
                        .etiquette()
                        .foregroundStyle(infos.pending ? Theme.glowInk : (allume ? Theme.ink.opacity(0.8) : Theme.faint))
                }
                .padding(13)
            }
            .contentShape(Rectangle())
            .gesture(geste(hauteur: geo.size.height))
        }
        .frame(minHeight: hauteur)
        .carte(allume)
        .opacity(infos.injoignable ? 0.6 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(device.label)
        .accessibilityValue(variable ? "\(Int(niveau)) %" : (allume ? "allumé" : "éteint"))
        .accessibilityAddTraits(.isButton)
        // Le geste de glissement n'existe pas sous VoiceOver : le balayage est
        // capté par le rotor. Sans l'action ajustable ci-dessous, l'intensité
        // serait inatteignable — la tuile n'a aucun bouton +/- de secours.
        // Et comme cette action s'empare du balayage, il faut redonner
        // explicitement la bascule, sinon allumer devient impossible.
        .accessibilityAction {
            guard !infos.injoignable else { return }
            Task { await store.envoyer(.power(on: !allume), a: device.id) }
        }
        .accessibilityAdjustableAction { sens in
            guard variable, !infos.injoignable else { return }
            let cible = sens == .increment ? Swift.min(100, niveau + 5) : Swift.max(0, niveau - 5)
            Task {
                if cible == 0 { await store.envoyer(.power(on: false), a: device.id) }
                else { await store.envoyer(.dim(level: Int(Swift.max(5, cible))), a: device.id) }
            }
        }
    }

    /// Toucher = basculer, glisser = régler. Le seuil sépare le doigt qui
    /// appuie du doigt qui bouge — pas d'appui long à deviner.
    private func geste(hauteur: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { g in
                guard variable, !infos.injoignable, abs(g.translation.height) > 8 else { return }
                let delta = -g.translation.height / hauteur * 100
                apercu = Swift.min(100, Swift.max(0, niveau + delta)).rounded()
            }
            .onEnded { g in
                guard !infos.injoignable else { return }
                if let v = apercu, abs(g.translation.height) > 8 {
                    Task {
                        if v == 0 { await store.envoyer(.power(on: false), a: device.id) }
                        else { await store.envoyer(.dim(level: Int(Swift.max(5, v))), a: device.id) }
                    }
                } else {
                    Task { await store.envoyer(.power(on: !allume), a: device.id) }
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { apercu = nil }
            }
    }
}
