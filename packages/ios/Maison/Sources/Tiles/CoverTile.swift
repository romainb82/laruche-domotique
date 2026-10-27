import SwiftUI
import DomoKit

/// Un volet.
///
/// Même métaphore que la lampe, retournée : le tablier descend depuis le haut,
/// exactement comme le vrai. On glisse vers le bas pour fermer : le geste est
/// celui du volet lui-même.
struct CoverTile: View {
    let device: Device
    @Environment(HouseStore.self) private var store
    @State private var apercu: Double?
    /// La hauteur suit le texte : figée, elle rognerait le contenu agrandi.
    @ScaledMetric(relativeTo: .body) private var hauteur: CGFloat = 122

    private var etat: DeviceState? { store.state(device.id) }
    private var infos: EtatTuile { EtatTuile(etat: etat) }
    private var position: Double { apercu ?? etat?.coverPosition ?? 0 }
    private var bouge: CoverMotion? { etat?.coverMoving }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                LinearGradient(colors: [Theme.jour.opacity(0.35), Theme.jour.opacity(0.1)],
                               startPoint: .top, endPoint: .bottom)

                // Le tablier à lames, qui descend.
                VStack(spacing: 0) {
                    ForEach(0..<5, id: \.self) { _ in
                        Rectangle().fill(Theme.raised)
                            .overlay(alignment: .bottom) {
                                Rectangle().fill(Theme.ink.opacity(0.12)).frame(height: 1)
                            }
                    }
                }
                .frame(height: geo.size.height * (100 - position) / 100)
                .animation(.spring(duration: 0.45), value: position)

                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .top) {
                        Image(systemName: bouge == nil ? "blinds.horizontal.closed"
                                                       : (bouge == .down ? "arrow.down" : "arrow.up"))
                            .police(16)
                            .frame(width: 34, height: 34)
                            .background(Theme.ink.opacity(0.06))
                            .foregroundStyle(bouge == nil ? Theme.soft : Theme.jour)
                            .clipShape(Circle())
                        Spacer()
                        if !infos.injoignable {
                            Text("\(Int(position))%")
                                .police(15, .semibold, .monospaced)
                                .foregroundStyle(Theme.ink)
                        }
                    }
                    Spacer()
                    Text(device.label)
                        .police(13, .semibold)
                        .lineLimit(1)
                        .foregroundStyle(Theme.ink)
                    Text(mention).etiquette()
                        .foregroundStyle(bouge != nil ? Theme.jourInk : Theme.soft)
                }
                .padding(13)
            }
            .contentShape(Rectangle())
            .gesture(geste(hauteur: geo.size.height))
        }
        .frame(minHeight: hauteur)
        .carte()
        .opacity(infos.injoignable ? 0.6 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(device.label)
        .accessibilityValue("\(Int(position)) % ouvert")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction {
            guard !infos.injoignable else { return }
            Task { await store.envoyer(.cover(position: position > 50 ? 0 : 100), a: device.id) }
        }
        .accessibilityAdjustableAction { sens in
            guard !infos.injoignable else { return }
            let cible = sens == .increment ? Swift.min(100, position + 10) : Swift.max(0, position - 10)
            Task { await store.envoyer(.cover(position: Int(cible)), a: device.id) }
        }
        // Un volet met plusieurs secondes à arriver : sans annonce, sa fin de
        // course n'existe pas pour qui ne regarde pas l'écran.
        .onChange(of: bouge) { avant, apres in
            guard avant != nil, apres == nil else { return }
            AccessibilityNotification.Announcement(
                "\(device.label) \(position == 0 ? "fermé" : position == 100 ? "ouvert" : "arrêté à \(Int(position)) %")"
            ).post()
        }
    }

    private var mention: String {
        if let b = bouge { return b == .down ? "fermeture…" : "ouverture…" }
        if !infos.mention.isEmpty { return infos.mention }
        return position == 0 ? "fermé" : position == 100 ? "ouvert" : "entrouvert"
    }

    private func geste(hauteur: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { g in
                guard !infos.injoignable, abs(g.translation.height) > 8 else { return }
                let delta = -g.translation.height / hauteur * 100
                apercu = Swift.min(100, Swift.max(0, (etat?.coverPosition ?? 0) + delta)).rounded()
            }
            .onEnded { g in
                guard !infos.injoignable else { return }
                let cible: Int
                if let v = apercu, abs(g.translation.height) > 8 { cible = Int(v) }
                else { cible = position > 50 ? 0 : 100 }   // un toucher bascule
                Task { await store.envoyer(.cover(position: cible), a: device.id) }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { apercu = nil }
            }
    }
}
