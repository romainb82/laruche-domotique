import SwiftUI
import DomoKit

/// Aiguille vers la tuile qui correspond à la nature de l'équipement.
struct DeviceTile: View {
    let device: Device
    @Environment(HouseStore.self) private var store

    var body: some View {
        switch device.type {
        case .light, .dimmer: LightTile(device: device)
        case .cover:          CoverTile(device: device)
        case .thermostat:     ClimateTile(device: device)
        case .sensor:         SensorTile(device: device)
        }
    }
}

/// Ce qu'une tuile doit toujours savoir dire.
///
/// Trois états visuels, jamais deux : connu, en cours, injoignable. C'est ce
/// qui distingue une domotique en laquelle on a confiance d'une domotique
/// qu'on double en allant vérifier de ses yeux.
struct EtatTuile {
    let etat: DeviceState?

    var pending: Bool { etat?.pending ?? false }
    var injoignable: Bool { !(etat?.health.isActionable ?? false) }

    var mention: String {
        if pending { return "en cours…" }
        if etat?.health == .stale { return "valeur périmée" }
        if injoignable { return "hors ligne" }
        return ""
    }
}
