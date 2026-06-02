import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

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
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fade-in"
      onClick={onClose}
    >
      <div 
        className="w-full max-w-sm bg-white border border-gray-200 p-6.5 rounded-[32px] shadow-2xl relative select-none animate-scale-up"
        onClick={e => e.stopPropagation()}
      >
        {/* Close Button */}
        <button 
          className="absolute top-4.5 right-4.5 text-gray-400 text-lg hover:text-gray-700 transition-colors"
          onClick={onClose}
        >
          &times;
        </button>

        <h2 className="font-sports text-2xl font-black text-center text-gray-900 mb-6 tracking-tight">
          {isLogin ? 'Sign In to Arena' : 'Create Account'}
        </h2>

        {error && (
          <div className="text-xs font-black text-rose-600 bg-rose-50 border border-rose-100 p-3 rounded-xl mb-4.5">
            {error}
          </div>
        )}
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input 
              type="email" 
              placeholder="Email Address" 
              className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-4 py-3.5 text-xs text-gray-800 placeholder-gray-400 focus:outline-none focus:bg-white focus:border-indigo-500 transition-colors shadow-sm"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required 
            />
          </div>
          <div>
            <input 
              type="password" 
              placeholder="Password" 
              className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-4 py-3.5 text-xs text-gray-800 placeholder-gray-400 focus:outline-none focus:bg-white focus:border-indigo-500 transition-colors shadow-sm"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required 
            />
          </div>

          <button 
            disabled={loading} 
            type="submit" 
            className="w-full py-4.5 bg-gradient-to-r from-indigo-600 to-violet-600 text-white text-xs font-black uppercase tracking-wider rounded-2xl shadow-md shadow-indigo-600/10 active:scale-95 transition-transform disabled:opacity-50 mt-2"
          >
            {isLogin ? 'Enter Arena' : 'Sign Up'}
          </button>
        </form>

        <div className="flex items-center text-center my-6 text-[9px] uppercase font-black tracking-widest text-gray-400">
          <div className="flex-1 border-t border-gray-200"></div>
          <span className="px-3">OR</span>
          <div className="flex-1 border-t border-gray-200"></div>
        </div>

        {/* Premium Google Button */}
        <button 
          disabled={loading} 
          onClick={handleGoogleSignIn} 
          className="w-full py-4 bg-white border border-gray-200 hover:bg-gray-50 rounded-2xl text-[10px] font-black uppercase text-gray-700 tracking-wider flex items-center justify-center gap-2 active:scale-95 transition-all shadow-sm"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24">
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
            />
            <path
              fill="#EA4335"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
            />
          </svg>
          Sign in with Google
        </button>

        <div className="mt-6 text-center text-xs font-semibold text-gray-500">
          {isLogin ? "Don't have an account? " : "Already have an account? "}
          <button 
            className="text-indigo-600 font-extrabold hover:text-indigo-700 hover:underline ml-1"
            onClick={() => setIsLogin(!isLogin)}
          >
            {isLogin ? 'Sign Up' : 'Sign In'}
          </button>
        </div>
      </div>
    </div>
  );
}
