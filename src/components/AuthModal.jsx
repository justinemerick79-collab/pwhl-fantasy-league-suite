import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { X, Shield } from 'lucide-react';

export default function AuthModal({ isOpen, onClose }) {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login, signup, loginWithGoogle } = useAuth();

  if (!isOpen) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (isLogin) {
        await login(email, password);
      } else {
        await signup(email, password);
      }
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to authenticate');
    }
    setLoading(false);
  }

  async function handleGoogleSignIn() {
    setError('');
    setLoading(true);
    try {
      await loginWithGoogle();
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to sign in with Google');
    }
    setLoading(false);
  }

  return (
    <div 
      className="fixed inset-0 bg-slate-900/60 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-fade-in"
      onClick={onClose}
    >
      <div 
        className="w-full max-w-sm bg-white border border-slate-200/80 p-6.5 rounded-2xl shadow-xl relative select-none animate-scale-up text-slate-800"
        onClick={e => e.stopPropagation()}
      >
        {/* Close Button */}
        <button 
          className="absolute top-4.5 right-4.5 text-slate-400 hover:text-slate-700 transition-colors cursor-pointer"
          onClick={onClose}
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex flex-col items-center mb-6">
          <div className="w-10 h-10 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-700 mb-2">
            <Shield className="w-5 h-5" />
          </div>
          <h2 className="font-sports text-xl font-bold text-center text-slate-800">
            {isLogin ? 'Sign In' : 'Create Account'}
          </h2>
        </div>

        {error && (
          <div className="text-xs font-semibold text-red-600 bg-red-50 border border-red-200 p-3 rounded-lg mb-4 text-center">
            {error}
          </div>
        )}
        
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <input 
              type="email" 
              placeholder="Email Address" 
              className="input-field"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required 
            />
          </div>
          <div>
            <input 
              type="password" 
              placeholder="Password" 
              className="input-field"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required 
            />
          </div>

          <button 
            disabled={loading} 
            type="submit" 
            className="w-full py-2.5 bg-slate-700 hover:bg-slate-600 text-white text-xs font-semibold rounded-lg transition-all disabled:opacity-50 mt-1 cursor-pointer"
          >
            {isLogin ? 'Sign In' : 'Sign Up'}
          </button>
        </form>

        <div className="my-4 flex items-center gap-3">
          <div className="flex-1 h-px bg-slate-200"></div>
          <span className="text-[10px] font-semibold uppercase text-slate-400">OR</span>
          <div className="flex-1 h-px bg-slate-200"></div>
        </div>

        <button 
          onClick={handleGoogleSignIn}
          disabled={loading}
          className="w-full py-2.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg transition-all flex items-center justify-center gap-2 cursor-pointer"
        >
          <span>Sign in with Google</span>
        </button>

        <div className="mt-5 text-center">
          <button 
            onClick={() => setIsLogin(!isLogin)}
            className="text-xs font-medium text-slate-500 hover:text-slate-800 cursor-pointer"
          >
            {isLogin ? "Don't have an account? Sign Up" : "Already registered? Sign In"}
          </button>
        </div>
      </div>
    </div>
  );
}
