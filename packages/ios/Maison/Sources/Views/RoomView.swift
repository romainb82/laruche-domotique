import SwiftUI
import DomoKit

/// Une pièce.
///
/// Même idée directrice que sur le web : en entrant, on doit pouvoir agir sur
/// la pièce ENTIÈRE avant de descendre dans le détail. D'où l'arc en tête.
struct RoomView: View {
    let zoneId: String
    @Environment(HouseStore.self) private var store
    @State private var apercu: Double?

    private var zone: Zone? { store.zone(zoneId) }
    private var equipements: [Device] { store.devices(dans: zoneId) }
    private var eclairages: [Device] { equipements.filter(\.isLight) }
    private var variables: [Device] { equipements.filter { $0.type == .dimmer } }
    private var volets: [Device] { equipements.filter { $0.type == .cover } }
    private var chauffage: [Device] { equipements.filter { $0.type == .thermostat } }
    private var capteurs: [Device] { equipements.filter { $0.type == .sensor } }
    private var allumes: Int { eclairages.filter { store.state($0.id)?.isOn == true }.count }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                entete
                if let c = cadran { arc(c) }
                groupes
            }
            .padding(18)
        }
        .background(Theme.ground)
        .navigationTitle(zone?.label ?? "Pièce")
        .navigationBarTitleDisplayMode(.inline)
        // La première nouvelle du matériel efface l'aperçu : à partir de là,
        // l'arc montre ce que la maison fait vraiment.
        .onChange(of: valeurReelle) { _, _ in apercu = nil }
    }

    /// Ce que le cadran montrerait sans aperçu : sert à savoir quand le matériel a parlé.
    private var valeurReelle: Double {
        switch mode {
        case .climat: chauffage.first.flatMap { store.state($0.id)?.climate?.setpoint } ?? 0
        case .lumiere: niveauLumiere
        case .volets: ouvertureVolets
        case nil: 0
        }
    }

    // MARK: En-tête

    private var entete: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text("\(equipements.count) équipements").etiquette()
                Text(zone?.label ?? "")
                    .police(34, .semibold)
                    .foregroundStyle(Theme.ink)
            }

            if !ambiance.isEmpty {
                // En gros caractères la ligne ne tient plus : elle passe en
                // colonne plutôt que de couper « 20,5 » de ses degrés.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 22) { mesuresAmbiance }
                    VStack(alignment: .leading, spacing: 8) { mesuresAmbiance }
                }
            }

            // Même règle pour les commandes d'ensemble : côte à côte tant
            // qu'elles tiennent, sinon empilées : jamais coupées en plein mot.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { commandesPiece }
                VStack(alignment: .leading, spacing: 8) { commandesPiece }
            }
        }
    }

    @ViewBuilder private var mesuresAmbiance: some View {
        ForEach(ambiance, id: \.symbole) { a in
            HStack(spacing: 6) {
                Image(systemName: Icone.pour(a.symbole))
                    .police(15).foregroundStyle(Theme.faint)
                    .accessibilityHidden(true)
                Text(a.texte)
                    .police(18, .semibold, .monospaced)
                    .lineLimit(1)
            }
        }
    }

    @ViewBuilder private var commandesPiece: some View {
        if !eclairages.isEmpty {
            pastille(allumes > 0 ? "Éteindre la pièce" : "Allumer la pièce", vive: allumes > 0) {
                Task { await store.envoyer(.power(on: allumes == 0), a: eclairages.map(\.id)) }
            }
        }
        if !volets.isEmpty {
            pastille("Fermer") { Task { await store.envoyer(.cover(position: 0), a: volets.map(\.id)) } }
            pastille("Ouvrir") { Task { await store.envoyer(.cover(position: 100), a: volets.map(\.id)) } }
        }
    }

    private func pastille(_ titre: String, vive: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(titre)
                .police(14, .medium)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.horizontal, 16).padding(.vertical, 10)
                .frame(minHeight: 44)          // 44 pt : le minimum tactile d'Apple
                .background(vive ? Theme.glow.opacity(0.12) : Theme.surface)
                .foregroundStyle(vive ? Theme.glowInk : Theme.soft)
                .clipShape(Capsule())
                .overlay(Capsule().strokeBorder(vive ? Theme.glow.opacity(0.5) : Theme.line))
        }
        .buttonStyle(.plain)
    }

    // MARK: L'arc

    /// Ce que l'arc commande, par ordre d'utilité : le chauffage s'il y en a
    /// un, sinon la lumière de la pièce, sinon la position des volets.
    private enum Mode { case climat, lumiere, volets }

    private var mode: Mode? {
        if !chauffage.isEmpty { return .climat }
        if !eclairages.isEmpty { return .lumiere }
        if !volets.isEmpty { return .volets }
        return nil
    }

    private struct Cadran {
        let valeur, min, max, pas: Double
        let texte, unite, legende: String
        let teinte: Color
        let desactive: Bool
    }

    private var cadran: Cadran? {
        guard let mode else { return nil }
        switch mode {
        case .climat:
            let c = chauffage.first.flatMap { store.state($0.id)?.climate }
            let bornes = store.config?.heating
            let min = bornes?.minSetpoint ?? 14, max = bornes?.maxSetpoint ?? 24
            let v = apercu ?? c?.setpoint ?? min
            return Cadran(valeur: v, min: min, max: max, pas: 0.5,
                          texte: String(format: "%.1f", v), unite: "°",
                          legende: c.map { String(format: "%.1f° mesurés", $0.ambient) } ?? "hors ligne",
                          teinte: Theme.glow, desactive: c == nil)
        case .lumiere:
            let v = apercu ?? niveauLumiere
            return Cadran(valeur: v, min: 0, max: 100, pas: 5,
                          texte: "\(Int(v))", unite: "%",
                          legende: allumes > 0 ? "\(allumes) allumé\(allumes > 1 ? "s" : "")" : "éteint",
                          teinte: Theme.glow, desactive: false)
        case .volets:
            let v = apercu ?? ouvertureVolets
            return Cadran(valeur: v, min: 0, max: 100, pas: 5,
                          texte: "\(Int(v))", unite: "%",
                          legende: v == 0 ? "fermés" : v == 100 ? "ouverts" : "entrouverts",
                          teinte: Theme.jour, desactive: false)
        }
    }

    private func arc(_ c: Cadran) -> some View {
        RadialDial(valeur: c.valeur, min: c.min, max: c.max, texte: c.texte,
                   unite: c.unite, legende: c.legende, pas: c.pas,
                   teinte: c.teinte, desactive: c.desactive,
                   onApercu: { v in apercu = v }) { v in
            apercu = v
            regler(v)
            // L'aperçu n'est pas une mise à jour optimiste : il meurt dès que
            // le matériel parle (voir `onChange` plus bas), ou au plus tard
            // après trois secondes.
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { apercu = nil }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .carte()
    }

    private func regler(_ v: Double) {
        guard let mode else { return }
        switch mode {
        case .climat:
            if let t = chauffage.first { Task { await store.envoyer(.climate(setpoint: v), a: t.id) } }
        case .lumiere:
            Task {
                if v == 0 {
                    await store.envoyer(.power(on: false), a: eclairages.map(\.id))
                } else {
                    if !variables.isEmpty {
                        await store.envoyer(.dim(level: Int(Swift.max(5, v))), a: variables.map(\.id))
                    }
                    let simples = eclairages.filter { $0.type == .light }
                    if !simples.isEmpty { await store.envoyer(.power(on: true), a: simples.map(\.id)) }
                }
            }
        case .volets:
            Task { await store.envoyer(.cover(position: Int(v)), a: volets.map(\.id)) }
        }
    }

    private var niveauLumiere: Double {
        let on = eclairages.filter { store.state($0.id)?.isOn == true }
        guard !on.isEmpty else { return 0 }
        return (on.reduce(0.0) { $0 + (store.state($1.id)?.level ?? 100) } / Double(on.count)).rounded()
    }

    private var ouvertureVolets: Double {
        let p = volets.compactMap { store.state($0.id)?.coverPosition }
        guard !p.isEmpty else { return 0 }
        return (p.reduce(0, +) / Double(p.count)).rounded()
    }

    // MARK: Ambiance et grille

    /// Les mesures d'ambiance montent en tête : elles décrivent la pièce.
    private var ambiance: [(symbole: String, texte: String, metric: Metric)] {
        var sortie: [(String, String, Metric)] = []
        for (m, s) in [(Metric.temperature, "thermo"), (.humidity, "goutte"), (.lux, "soleil")] {
            guard let d = capteurs.first(where: { $0.metric == m }), store.estJoignable(d.id),
                  let mesure = store.state(d.id)?.measure else { continue }
            let v = mesure.value == mesure.value.rounded()
                ? String(Int(mesure.value)) : String(format: "%g", mesure.value)
            sortie.append((s, v + mesure.unit, m))
        }
        return sortie.map { (symbole: $0.0, texte: $0.1, metric: $0.2) }
    }

    /// Les capteurs déjà résumés en tête ne sont pas répétés dans la grille.
    private var capteursRestants: [Device] {
        let vus = Set(ambiance.map(\.metric))
        return capteurs.filter { $0.metric.map { !vus.contains($0) } ?? true }
    }

    private var groupes: some View {
        VStack(alignment: .leading, spacing: 22) {
            groupe("Éclairage", eclairages)
            groupe("Volets", volets)
            groupe("Chauffage", chauffage, large: true)
            groupe("Mesures", capteursRestants)
        }
    }

    @ViewBuilder
    private func groupe(_ titre: String, _ items: [Device], large: Bool = false) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text(titre).etiquette()
                if large {
                    VStack(spacing: 12) { ForEach(items) { DeviceTile(device: $0) } }
                } else {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                        ForEach(items) { DeviceTile(device: $0) }
                    }
                }
            }
        }
    }
}
