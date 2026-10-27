import SwiftUI
import DomoKit

/// Le chauffage. Une consigne, pas un interrupteur.
struct ClimateTile: View {
    let device: Device
    @Environment(HouseStore.self) private var store

    private var etat: DeviceState? { store.state(device.id) }
    private var infos: EtatTuile { EtatTuile(etat: etat) }
    private var climat: (setpoint: Double, ambient: Double, demand: Bool)? { etat?.climate }

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: "thermometer.medium")
                .police(17)
                .frame(width: 36, height: 36)
                .background(climat?.demand == true ? Theme.glow : Theme.ink.opacity(0.06))
                .foregroundStyle(climat?.demand == true ? Theme.surface : Theme.faint)
                .clipShape(Circle())
                .accessibilityHidden(true)

            // Regroupe le seul bloc descriptif : englober tout le HStack
            // avalerait les deux boutons et leur ôterait leur action propre.
            VStack(alignment: .leading, spacing: 2) {
                Text(device.label).police(13, .semibold).lineLimit(1)
                Text(mention).etiquette()
            }
            .accessibilityElement(children: .combine)
            Spacer()

            HStack(spacing: 10) {
                pas("minus", -0.5, "Diminuer la consigne")
                Text(climat.map { String(format: "%.1f", $0.setpoint) } ?? "-")
                    .police(24, .semibold, .monospaced)
                    .frame(width: 62)
                    .accessibilityLabel("Consigne")
                    .accessibilityValue(climat.map { String(format: "%.1f degrés", $0.setpoint) } ?? "inconnue")
                pas("plus", 0.5, "Augmenter la consigne")
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity)
        .carte(climat?.demand == true)
        .opacity(infos.injoignable ? 0.6 : 1)
    }

    private var mention: String {
        if !infos.mention.isEmpty { return infos.mention }
        guard let c = climat else { return "" }
        return c.demand ? "chauffe · \(String(format: "%.1f", c.ambient))° mesurés"
                        : "au repos · \(String(format: "%.1f", c.ambient))° mesurés"
    }

    private func pas(_ symbole: String, _ delta: Double, _ libelle: String) -> some View {
        Button {
            guard let c = climat, let bornes = store.config?.heating else { return }
            let v = Swift.min(bornes.maxSetpoint, Swift.max(bornes.minSetpoint, c.setpoint + delta))
            if v != c.setpoint { Task { await store.envoyer(.climate(setpoint: v), a: device.id) } }
        } label: {
            Image(systemName: symbole)
                .police(16, .light)
                .frame(width: 44, height: 44)   // 44 pt : le minimum tactile d'Apple
                .background(Theme.ink.opacity(0.06))
                .foregroundStyle(Theme.ink)
                .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(infos.injoignable)
        .accessibilityLabel(libelle)
    }
}
