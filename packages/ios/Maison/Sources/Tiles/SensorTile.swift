import SwiftUI
import DomoKit

/// Une mesure.
///
/// Elle se remplit à hauteur de la valeur dans sa plage normale : une humidité
/// à 80 % ou un pH hors cible se voient avant d'être lus. Une valeur périmée
/// n'est jamais affichée — elle devient un tiret.
struct SensorTile: View {
    let device: Device
    @Environment(HouseStore.self) private var store
    /// La hauteur suit le texte : figée, elle rognerait le contenu agrandi.
    @ScaledMetric(relativeTo: .body) private var hauteur: CGFloat = 122

    private var etat: DeviceState? { store.state(device.id) }
    private var infos: EtatTuile { EtatTuile(etat: etat) }
    private var mesure: (metric: Metric, value: Double, unit: String)? { etat?.measure }

    /// Plages « normales », qui donnent son sens au remplissage.
    private static let plages: [Metric: ClosedRange<Double>] = [
        .temperature: 10...30, .humidity: 20...80, .lux: 0...15000,
        .ph: 6.5...8, .orp: 500...850, .power: 0...4000, .battery: 0...100,
    ]

    private var remplissage: Double {
        guard let m = mesure, let p = Self.plages[m.metric], !infos.injoignable else { return 0 }
        return Swift.min(1, Swift.max(0, (m.value - p.lowerBound) / (p.upperBound - p.lowerBound)))
    }

    /// Le pH hors plage est la seule mesure qui doit sauter aux yeux.
    private var alerte: Bool {
        guard let m = mesure, m.metric == .ph, !infos.injoignable,
              let cible = store.config?.pool.phTarget, cible.count == 2 else { return false }
        return m.value < cible[0] || m.value > cible[1]
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottomLeading) {
                (alerte ? Theme.crit.opacity(0.22) : Theme.jour.opacity(0.18))
                    .frame(height: geo.size.height * remplissage)
                    .frame(maxHeight: .infinity, alignment: .bottom)
                    .animation(.easeInOut(duration: 0.6), value: remplissage)

                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .top) {
                        Image(systemName: Icone.pour(symbole))
                            .police(16)
                            .frame(width: 34, height: 34)
                            .background(Theme.ink.opacity(0.06))
                            .foregroundStyle(alerte ? Theme.crit : Theme.faint)
                            .clipShape(Circle())
                            .accessibilityHidden(true)
                        Spacer()
                        if alerte {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .police(14).foregroundStyle(Theme.crit)
                                .accessibilityHidden(true)
                        }
                    }
                    Spacer()
                    HStack(alignment: .firstTextBaseline, spacing: 2) {
                        Text(texte)
                            .police(22, .semibold, .monospaced)
                            .foregroundStyle(alerte ? Theme.crit : (infos.injoignable ? Theme.faint : Theme.ink))
                        if let u = mesure?.unit, !u.isEmpty, !infos.injoignable {
                            Text(u).police(11).foregroundStyle(Theme.soft)
                        }
                    }
                    Text(device.label)
                        .police(12, .medium)
                        .lineLimit(1)
                        .foregroundStyle(Theme.soft)
                        .padding(.top, 5)
                    if !infos.mention.isEmpty { Text(infos.mention).etiquette() }
                }
                .padding(13)
            }
        }
        .frame(minHeight: hauteur)
        .carte()
        .opacity(infos.injoignable ? 0.6 : 1)
        // Sans regroupement, VoiceOver lisait six arrêts séparés — et l'alerte
        // pH, portée par un triangle rouge sans texte, n'était jamais dite.
        .accessibilityElement(children: .combine)
        .accessibilityLabel(device.label)
        .accessibilityValue(annonce)
    }

    /// La mesure telle qu'elle se dit : valeur, unité, et l'alerte en toutes lettres.
    private var annonce: String {
        var t = texte
        if let u = mesure?.unit, !u.isEmpty, !infos.injoignable { t += " \(u)" }
        if alerte { t += ", hors de la plage cible" }
        if !infos.mention.isEmpty { t += ", \(infos.mention)" }
        return t
    }

    private var symbole: String {
        switch mesure?.metric {
        case .temperature: "thermo"
        case .humidity: "goutte"
        case .lux: "soleil"
        case .ph, .orp: "piscine"
        case .power: "eclair"
        case .contact: "porte"
        default: "maison"
        }
    }

    private var texte: String {
        guard let m = mesure, !infos.injoignable else { return "—" }
        if m.metric == .contact { return m.value > 0 ? "Ouvert" : "Fermé" }
        return m.value == m.value.rounded() ? String(Int(m.value)) : String(format: "%g", m.value)
    }
}
