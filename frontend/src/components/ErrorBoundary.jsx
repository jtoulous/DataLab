import React from "react";


// Isole une erreur de rendu (ex : graphique invalide) dans son panneau au lieu de demonter toute l'application
class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { error: null };
    }

    static getDerivedStateFromError(error) {
        return { error };
    }

    componentDidUpdate(prevProps) {
        // nouvelles donnees -> on retente l'affichage
        if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
            this.setState({ error: null });
        }
    }

    render() {
        if (this.state.error) {
            return <div className={this.props.className || ''}>Display error: {String(this.state.error.message || this.state.error)}</div>;
        }
        return this.props.children;
    }
}

export default ErrorBoundary;
