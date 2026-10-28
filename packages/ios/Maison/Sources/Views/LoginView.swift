import SwiftUI
import DomoKit

/// La porte d'entrée, sur téléphone.
///
/// Même parti pris que sur le web : on choisit SON VISAGE avant de taper quoi
/// que ce soit, et l'identifiant n'est demandé que si la maison refuse de
/// lister ses habitants. Le jeton obtenu va dans le trousseau, jamais ailleurs.
///
/// Trois cas, du plus fréquent au plus rare : se connecter, taper son
/// identifiant, créer le tout premier compte.
struct LoginView: View {
    @Environment(HouseStore.self) private var store

    @State private var choisi: Habitant?
    @State private var identifiant = ""
    @State private var nom = ""
    @State private var motDePasse = ""
    @State private var refus: String?
    @State private var envoi = false
    @FocusState private var champ: Champ?

    private enum Champ { case identifiant, nom, motDePasse }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                entete
                if !store.installe {
                    premierCompte
                } else {
                    if !store.habitants.isEmpty { visages }
                    if store.habitants.isEmpty || choisi == nil {
                        champIdentifiant
                    }
                    champMotDePasse
                }
                if let refus {
                    Text(refus)
                        .police(14)
                        .foregroundStyle(Theme.crit)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.crit.opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .accessibilityAddTraits(.isStaticText)
                }
                bouton
                Text("Connexion locale au serveur de la maison. Rien ne passe par Internet.")
                    .police(12)
                    .foregroundStyle(Theme.faint)
            }
            .padding(22)
        }
        .background(Theme.ground)
        .scrollDismissesKeyboard(.interactively)
    }

    // MARK: Morceaux

    private var entete: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("La Ruche · réseau local").etiquette()
            Text(store.installe ? "Bon retour à la maison" : "Bienvenue")
                .police(30, .semibold)
                .foregroundStyle(Theme.ink)
            Text(store.installe ? "Qui se connecte ?" : "La maison n’a pas encore d’administrateur : créez le premier compte.")
                .police(15)
                .foregroundStyle(Theme.soft)
        }
        .padding(.top, 30)
    }

    private var visages: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            ForEach(store.habitants) { h in
                Button {
                    choisi = h
                    identifiant = ""
                    champ = .motDePasse
                } label: {
                    HStack(spacing: 10) {
                        Text(h.initiale)
                            .police(15, .semibold)
                            .frame(width: 36, height: 36)
                            .background(Theme.glow.opacity(0.15))
                            .foregroundStyle(Theme.glowInk)
                            .clipShape(Circle())
                        VStack(alignment: .leading, spacing: 1) {
                            Text(h.nom).police(15, .semibold).foregroundStyle(Theme.ink)
                            Text(h.role.label).police(12).foregroundStyle(Theme.soft)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(12)
                    .frame(minHeight: 60)
                    .carte(choisi?.id == h.id)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(h.nom), \(h.role.label)")
                .accessibilityAddTraits(choisi?.id == h.id ? .isSelected : [])
            }
        }
    }

    private var champIdentifiant: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Identifiant").police(13, .medium).foregroundStyle(Theme.soft)
            TextField("", text: $identifiant)
                .textContentType(.username)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($champ, equals: .identifiant)
                .onChange(of: identifiant) { _, _ in choisi = nil }
                .modifier(Champ.Style())
        }
    }

    private var champMotDePasse: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Mot de passe").police(13, .medium).foregroundStyle(Theme.soft)
            SecureField("", text: $motDePasse)
                .textContentType(store.installe ? .password : .newPassword)
                .focused($champ, equals: .motDePasse)
                .submitLabel(.go)
                .onSubmit { Task { await valider() } }
                .modifier(Champ.Style())
        }
    }

    private var premierCompte: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Prénom").police(13, .medium).foregroundStyle(Theme.soft)
                TextField("", text: $nom)
                    .textContentType(.givenName)
                    .focused($champ, equals: .nom)
                    .modifier(Champ.Style())
            }
            champIdentifiant
            champMotDePasse
        }
    }

    private var bouton: some View {
        Button {
            Task { await valider() }
        } label: {
            HStack(spacing: 8) {
                Text(envoi ? "Connexion…" : store.installe ? "Ouvrir la maison" : "Créer le compte")
                    .police(16, .semibold)
                if !envoi { Image(systemName: "chevron.right").police(14, .semibold) }
            }
            .frame(maxWidth: .infinity, minHeight: 52)
            .background(Theme.glowInk)
            .foregroundStyle(.white)
            .clipShape(Capsule())
        }
        .disabled(envoi)
        .opacity(envoi ? 0.6 : 1)
    }

    // MARK: Action

    private func valider() async {
        refus = nil
        envoi = true
        defer { envoi = false }
        if !store.installe {
            refus = await store.premierCompte(identifiant: identifiant, nom: nom, motDePasse: motDePasse)
        } else if let choisi {
            refus = await store.connexion(compteId: choisi.id, motDePasse: motDePasse)
        } else {
            refus = await store.connexion(identifiant: identifiant, motDePasse: motDePasse)
        }
        if refus == nil {
            motDePasse = ""
        } else {
            AccessibilityNotification.Announcement(refus ?? "").post()
        }
    }
}

private extension LoginView.Champ {
    /// Le même champ partout : fond blanc, contour fin, 48 pt de haut.
    struct Style: ViewModifier {
        func body(content: Content) -> some View {
            content
                .police(16)
                .padding(.horizontal, 14)
                .frame(minHeight: 48)
                .background(Theme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(Theme.line, lineWidth: 1)
                )
        }
    }
}
